/**
 * Persistencia de salas.
 *
 * Dos almacenes, elegidos al arrancar:
 *
 *   • ARCHIVO (por defecto)  → data/salas.json (o $YR_SALAS_FILE). Local-first.
 *   • POSTGRES               → si existe $DATABASE_URL (Render/Supabase/Neon).
 *
 * API:
 *   - cargarSalas()      → Map<codigo, sala> hidratada (elige almacén solo)
 *   - iniciar(mapa)      → de dónde salen las salas a guardar
 *   - notificar()        → "hay cambios": guarda con 1,2 s de rebote
 *   - guardarYa()        → guarda ya y cierra (antes de salir del proceso)
 *
 * Las salas se guardan sin usuarios (nadie está conectado al reiniciar) y con
 * la posición de reproducción ya resuelta, de modo que al volver arrancan donde
 * estaban y el anfitrión recupera su rol con el token que guarda en navegador.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inicializar } from './plugins.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUTA = process.env.YR_SALAS_FILE || path.join(RAIZ, 'data', 'salas.json');
const DEBOUNCE_MS = 1200;
const VIDA_SALA_MS = 24 * 3600 * 1000; // salas vacías más viejas: fuera

let salas = null;
let temporizador = null;
let sucio = false;
let backend = 'archivo';
let pool = null; // conexión a Postgres, si la hay
let poolDePrueba = false; // true cuando el pool lo inyectan los tests

/* ------------------------------- escribir ------------------------------- */

export function serializarSala(room) {
  const ahora = Date.now();
  const posicion =
    room.playback.ref && room.playback.playing
      ? room.playback.position + (ahora - room.playback.updatedAt) / 1000
      : room.playback.position;
  const encuesta = room.encuesta
    ? {
        id: room.encuesta.id,
        pregunta: room.encuesta.pregunta,
        creador: room.encuesta.creador,
        creadaEn: room.encuesta.creadaEn,
        cerrada: room.encuesta.cerrada,
        opciones: room.encuesta.opciones.map((o) => ({ texto: o.texto, votos: [...o.votos] })),
      }
    : null;

  return {
    code: room.code,
    name: room.name,
    publica: Boolean(room.publica),
    hostId: room.hostId,
    ownerToken: room.ownerToken,
    controlPolicy: room.controlPolicy,
    createdAt: room.createdAt,
    // si hay gente conectada, "ahora"; si no, cuándo se vació la sala
    lastSeen: room.users.size > 0 ? ahora : room.lastSeen,
    plugins: room.plugins,
    encuesta,
    notas: room.notas,
    // sin `votes` (Set) ni usuarios: no tienen sentido fuera de la conexión
    queue: room.queue.map(({ votes, ...q }) => q),
    playback: { ...room.playback, position: posicion, updatedAt: ahora },
    chat: room.chat,
  };
}

function escribirArchivo() {
  if (!salas) return;
  const datos = { guardadoEn: Date.now(), salas: [...salas.values()].map(serializarSala) };
  mkdirSync(path.dirname(RUTA), { recursive: true });
  const tmp = `${RUTA}.tmp`;
  writeFileSync(tmp, JSON.stringify(datos));
  renameSync(tmp, RUTA); // escritura atómica: nunca queda un JSON a medias
}

async function escribirPostgres() {
  if (!pool || !salas) return;
  const filas = [...salas.values()].map(serializarSala);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const d of filas) {
      await client.query(
        `INSERT INTO salas (code, datos, actualizado) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (code) DO UPDATE SET datos = $2::jsonb, actualizado = $3`,
        [d.code, JSON.stringify(d), Date.now()],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Borra de la base las salas vacías y abandonadas (+24 h). */
async function limpiarPostgres() {
  if (!pool || !salas) return;
  const limite = Date.now() - VIDA_SALA_MS;
  const { rows } = await pool.query('SELECT code, datos FROM salas');
  const caducas = rows
    .map((r) => r.datos)
    .filter((d) => d && !d.queue?.length && !d.playback?.ref && (d.lastSeen || 0) < limite)
    .map((d) => d.code);
  for (const code of caducas) {
    await pool.query('DELETE FROM salas WHERE code = $1', [code]);
  }
  return caducas.length;
}

/* -------------------------------- leer --------------------------------- */

export function hidratar(d) {
  const room = {
    code: d.code,
    name: d.name || 'Sala',
    publica: Boolean(d.publica),
    hostId: d.hostId || null,
    ownerToken: d.ownerToken || null,
    controlPolicy: d.controlPolicy === 'everyone' ? 'everyone' : 'host',
    users: new Map(),
    queue: [],
    playback: {
      fuente: null, ref: null, url: null, title: null, thumbnail: null,
      duration: null, position: 0, playing: false, updatedAt: Date.now(),
    },
    skipVotes: new Set(),
    chat: [],
    recientes: new Map(),
    createdAt: d.createdAt || Date.now(),
    lastSeen: d.lastSeen || Date.now(),
  };
  inicializar(room); // plugins por defecto (catálogo + estados)
  room.plugins = { ...room.plugins, ...(d.plugins || {}) };
  room.queue = (d.queue || []).map((q) => ({ ...q, votes: new Set() }));
  if (d.playback) {
    room.playback = { ...room.playback, ...d.playback, updatedAt: Date.now() };
  }
  room.chat = d.chat || [];
  room.notas = d.notas || room.notas;
  room.encuesta = d.encuesta
    ? {
        id: d.encuesta.id,
        pregunta: d.encuesta.pregunta,
        creador: d.encuesta.creador,
        creadaEn: d.encuesta.creadaEn,
        cerrada: !!d.encuesta.cerrada,
        opciones: (d.encuesta.opciones || []).map((o) => ({ texto: o.texto, votos: new Set(o.votos || []) })),
      }
    : null;
  return room;
}

function cargarArchivo() {
  const mapa = new Map();
  if (!existsSync(RUTA)) return mapa;
  try {
    const datos = JSON.parse(readFileSync(RUTA, 'utf8'));
    for (const d of datos.salas || []) {
      if (!d || !d.code) continue;
      // salas vacías y abandonadas hace más de 24 h: no se restauran
      if (!d.queue?.length && !d.playback?.ref && Date.now() - (d.lastSeen || 0) > VIDA_SALA_MS) continue;
      mapa.set(d.code, hidratar(d));
    }
  } catch (e) {
    console.warn(`  ⚠ no pude leer ${RUTA}: ${e.message} (se empieza sin salas)`);
  }
  return mapa;
}

async function crearEsquema(p) {
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS salas (
        code       TEXT PRIMARY KEY,
        datos      JSONB NOT NULL,
        actualizado BIGINT NOT NULL
      )`);
  } catch (e) {
    // puede fallar si la tabla ya existe (motores quisquillosos) o si no hay
    // permisos de CREATE: lo importante es que se pueda usar
    await p.query('SELECT code FROM salas LIMIT 1');
  }
}

async function conectarPostgres() {
  // `pg` se importa solo si hay URL: quien no usa base de datos no la descarga
  const { default: pg } = await import('pg');
  const p = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === '0' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    max: 4,
  });
  return p;
}

async function cargarPostgres() {
  const mapa = new Map();
  const { rows } = await pool.query('SELECT datos FROM salas');
  for (const d of rows.map((r) => r.datos)) {
    if (!d?.code) continue;
    if (!d.queue?.length && !d.playback?.ref && Date.now() - (d.lastSeen || 0) > VIDA_SALA_MS) continue;
    mapa.set(d.code, hidratar(d));
  }
  return mapa;
}

/**
 * Elige almacén y carga las salas. Si $DATABASE_URL falla (o `pg` no está
 * instalado), se avisa por consola y se sigue con el archivo local.
 * Con `poolPrueba` se sustituye la conexión (para los tests, con pg-mem).
 */
export async function cargarSalas(poolPrueba = null) {
  if (poolPrueba || process.env.DATABASE_URL) {
    try {
      pool = poolPrueba || (await conectarPostgres());
      poolDePrueba = !!poolPrueba;
      await crearEsquema(pool);
      backend = 'postgres';
      console.log('  ♦ persistencia: PostgreSQL');
      const mapa = await cargarPostgres();
      await limpiarPostgres();
      return mapa;
    } catch (e) {
      console.warn(`  ⚠ PostgreSQL no disponible (${String(e.message).trim()}) → sigo con ${RUTA}`);
      if (pool && !poolPrueba) await pool.end().catch(() => {});
      pool = null;
      poolDePrueba = false;
      backend = 'archivo';
    }
  }
  return cargarArchivo();
}

export const almacenanActual = () => backend;

/* ------------------------------ programar ------------------------------ */

export function iniciar(mapa) {
  salas = mapa;
}

async function guardar() {
  if (backend === 'postgres') await escribirPostgres();
  else escribirArchivo();
}

export function notificar() {
  sucio = true;
  if (temporizador) return;
  temporizador = setTimeout(async () => {
    temporizador = null;
    if (!sucio) return;
    sucio = false;
    try { await guardar(); } catch (e) { console.warn(`  ⚠ guardando salas: ${e.message.trim()}`); }
  }, DEBOUNCE_MS);
}

/** Guarda ya y cierra el almacén. Apta para SIGINT/SIGTERM. */
export async function guardarYa() {
  if (temporizador) { clearTimeout(temporizador); temporizador = null; }
  sucio = false;
  try { await guardar(); } catch (e) { console.warn(`  ⚠ guardando salas: ${e.message.trim()}`); }
  if (pool && !poolDePrueba) { await pool.end().catch(() => {}); pool = null; }
}

/** Limpieza periódica (salas vacías >24 h). En archivo no hace falta. */
export async function limpiar() {
  if (backend !== 'postgres') return 0;
  try { return await limpiarPostgres(); } catch (e) {
    console.warn(`  ⚠ limpiando salas: ${e.message.trim()}`);
    return 0;
  }
}

/** Escritura de emergencia para el evento 'exit', que no admite `await`. */
export function guardarEmergencia() {
  if (backend !== 'archivo' || !salas) return;
  try { escribirArchivo(); } catch {}
}
