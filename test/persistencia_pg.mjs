/* Pruebas del almacén PostgreSQL (con pg-mem: un PostgreSQL emulado en JS).
 * No necesita servidor de BD: se inyecta el pool simulado en cargarSalas(). */
import { newDb } from 'pg-mem';
import path from 'node:path';
import { rmSync } from 'node:fs';

// aísalo del archivo real de salas (por si algún paso cae al respaldo)
const ARCHIVO_RESPALDO = path.join(process.cwd(), 'data', 'salas-pg-test.json');
process.env.YR_SALAS_FILE = ARCHIVO_RESPALDO;

const { Pool } = newDb().adapters.createPg();
const poolPrueba = new Pool();

const { serializarSala, hidratar, cargarSalas, iniciar, notificar, guardarYa, almacenanActual, limpiar, RUTA } =
  await import('../server/persistencia.js');

let fallos = 0;
const ok = (cond, nombre) => {
  console.log(`${cond ? '  PASS' : '✗ FAIL'}  ${nombre}`);
  if (!cond) fallos++;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* la tabla la crea el propio módulo al conectar */
const mapaInicial = await cargarSalas(poolPrueba);
ok(almacenanActual() === 'postgres', 'el almacén activo es PostgreSQL');
ok(mapaInicial.size === 0, 'una base recién creada empieza vacía');
ok(RUTA.length > 0, 'la ruta de archivo de respaldo sigue definida');

/* ---------------------------- guardar y leer ---------------------------- */
const ANTES = Date.now();
const sala = {
  code: 'PGTEST1',
  name: 'Sala en la nube',
  hostId: 'host-1',
  ownerToken: 'tok-pg',
  controlPolicy: 'everyone',
  users: new Map([['host-1', { id: 'host-1', name: 'Ana' }]]),
  queue: [
    { id: 'q1', fuente: 'youtube', ref: 'abcdefghijk', url: 'https://youtu.be/abcdefghijk',
      title: 'Vídeo de prueba', canal: 'Canal', thumbnail: 'x.jpg', duration: 100, addedBy: 'Ana', votes: new Set(['u2']) },
  ],
  playback: { fuente: 'youtube', ref: 'abcdefghijk', url: 'https://youtu.be/abcdefghijk', title: 'Vídeo de prueba',
    thumbnail: 'x.jpg', duration: 100, position: 30, playing: true, updatedAt: Date.now() - 4000 },
  skipVotes: new Set(),
  chat: [{ id: 'm1', userId: 'host-1', name: 'Ana', text: 'hola desde la base', at: ANTES }],
  createdAt: ANTES,
  lastSeen: ANTES,
  plugins: { encuestas: true, notas: false, reacciones: true },
  encuesta: { id: 'e1', pregunta: '¿Cuál?', creador: { id: 'host-1', name: 'Ana' }, creadaEn: ANTES, cerrada: false,
    opciones: [{ texto: 'A', votos: new Set(['u2']) }, { texto: 'B', votos: new Set() }] },
  notas: { texto: 'nota en base', por: 'Ana', en: ANTES },
  reaccionUltima: new Map(),
};

iniciar(new Map([[sala.code, sala]]));
notificar();
await espera(1600); // rebote de 1,2 s

const { rows } = await poolPrueba.query('SELECT code, datos FROM salas');
ok(rows.length === 1 && rows[0].code === 'PGTEST1', 'la sala se guardó en la tabla `salas`');
ok(typeof rows[0].datos === 'object' && rows[0].datos.name === 'Sala en la nube', 'el JSONB se guardó como objeto');
ok(!('users' in rows[0].datos), 'no se guardan usuarios (no hay conexión al reiniciar)');
ok(!('votes' in rows[0].datos.queue[0]), 'la cola se guarda sin los votos (Set)');

/* --------------------------- volver a cargar --------------------------- */
const mapa2 = await cargarSalas(poolPrueba);
ok(mapa2.size === 1 && mapa2.has('PGTEST1'), 'la sala se recarga con su código');
const r = mapa2.get('PGTEST1');

ok(r.users instanceof Map && r.users.size === 0, 'arranca sin usuarios conectados');
ok(r.ownerToken === 'tok-pg', 'el token del anfitrión se conserva');
ok(r.controlPolicy === 'everyone', 'los permisos se conservan');
ok(r.queue.length === 1 && r.queue[0].title === 'Vídeo de prueba', 'la cola se restaura');
ok(r.queue[0].votes instanceof Set, 'cada item de la cola vuelve a tener su Set de votos');
ok(r.playback.ref === 'abcdefghijk' && r.playback.playing === true, 'sigue en reproducción');
ok(r.playback.position >= 30, `la posición se congeló en el guardado (${r.playback.position.toFixed(1)} s)`);
ok(r.encuesta && r.encuesta.pregunta === '¿Cuál?', 'la encuesta vuelve');
ok(r.encuesta.opciones[0].votos instanceof Set && r.encuesta.opciones[0].votos.size === 1, 'los votos vuelven como Set');
ok(r.notas.texto === 'nota en base', 'las notas vuelven');
ok(r.plugins.notas === false && r.plugins.encuestas === true, 'los flags de plugins vuelven');
ok(r.chat.length === 1 && r.chat[0].text === 'hola desde la base', 'el chat vuelve');

/* --------------------------- sobrescritura (upsert) -------------------- */
sala.chat.push({ id: 'm2', userId: 'host-1', name: 'Ana', text: 'segundo', at: Date.now() });
notificar();
await espera(1600);
const mapa3 = await cargarSalas(poolPrueba);
const r3 = mapa3.get('PGTEST1');
ok(r3.chat.length === 2 && r3.chat[1].text === 'segundo', 'un segundo guardado sobrescribe la misma sala (upsert)');
const { rows: filas2 } = await poolPrueba.query('SELECT COUNT(*) AS n FROM salas');
ok(Number(filas2[0].n) === 1, 'no se duplican filas: hay una sola por sala');

/* ------------------------- limpieza de salas viejas -------------------- */
const hace25h = Date.now() - 25 * 3600 * 1000;
await poolPrueba.query(
  `INSERT INTO salas (code, datos, actualizado) VALUES ($1, $2::jsonb, $3)`,
  ['VIEJA01', JSON.stringify({ code: 'VIEJA01', name: 'vacía y vieja', queue: [], playback: { ref: null }, lastSeen: hace25h, chat: [] }), hace25h],
);
await poolPrueba.query(
  `INSERT INTO salas (code, datos, actualizado) VALUES ($1, $2::jsonb, $3)`,
  ['VIEJA02', JSON.stringify({ code: 'VIEJA02', name: 'vieja con vídeo', queue: [], playback: { ref: 'xyz', fuente: 'youtube' }, lastSeen: hace25h, chat: [] }), hace25h],
);
const borradas = await limpiar();
ok(borradas === 1, `la limpieza borra solo la sala vacía y vieja (${borradas} borrada)`);
const { rows: tras } = await poolPrueba.query('SELECT code FROM salas ORDER BY code');
ok(tras.length === 2 && tras[0].code === 'PGTEST1' && tras[1].code === 'VIEJA02',
  'quedan la sala activa y la antigua con vídeo');

/* ---------------------- guardarYa y cierre limpio ---------------------- */
await guardarYa();
ok(true, 'guardarYa cierra sin errores');

/* ------------- si la base no está, se cae al archivo local ------------- */
const { cargarSalas: cargar2, almacenanActual: backend2 } = await import('../server/persistencia.js?respaldo');
process.env.DATABASE_URL = 'postgres://usuario:clave@127.0.0.1:1/sinbase';
const mapaRespaldo = await cargar2();
ok(backend2() === 'archivo', 'si PostgreSQL no responde, se usa el archivo local');
ok(mapaRespaldo instanceof Map, 'y se devuelve un mapa (aunque vacío) sin lanzar');
delete process.env.DATABASE_URL;

rmSync(ARCHIVO_RESPALDO, { force: true });

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
setTimeout(() => process.exit(fallos ? 1 : 0), 300);
