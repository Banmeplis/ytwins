/* Pruebas de persistencia de salas (no necesita servidor en marcha). */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ARCHIVO = path.join(process.cwd(), 'data', 'salas-test.json');
process.env.YR_SALAS_FILE = ARCHIVO;

const { serializarSala, hidratar, cargarSalas, iniciar, notificar, guardarYa, RUTA } =
  await import('../server/persistencia.js');

let fallos = 0;
const ok = (cond, nombre) => {
  console.log(`${cond ? '  PASS' : '✗ FAIL'}  ${nombre}`);
  if (!cond) fallos++;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- sala de ejemplo --------------------------- */
const ANTES = Date.now();
const sala = {
  code: 'TEST01',
  name: 'Sala persistente',
  hostId: 'host-1',
  ownerToken: 'token-secreto',
  controlPolicy: 'everyone',
  users: new Map([['host-1', { id: 'host-1', name: 'Ana' }]]),
  queue: [
    { id: randomUUID(), fuente: 'youtube', ref: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up', canal: 'Rick Astley', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
      duration: 213, addedBy: 'Ana', votes: new Set(['u2', 'u3']) },
  ],
  playback: { fuente: 'youtube', ref: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up', thumbnail: 'x.jpg', duration: 213,
    position: 40, playing: true, updatedAt: Date.now() - 5000 }, // lleva 5 s rodando
  skipVotes: new Set(['u9']),
  chat: [{ id: 'm1', userId: 'host-1', name: 'Ana', text: 'hola', at: ANTES }],
  createdAt: ANTES,
  lastSeen: ANTES,
  plugins: { encuestas: true, notas: false, reacciones: true },
  encuesta: {
    id: 'enc_1', pregunta: '¿Pizza o tacos?', creador: { id: 'host-1', name: 'Ana' },
    creadaEn: ANTES, cerrada: false,
    opciones: [{ texto: 'Pizza', votos: new Set(['u2']) }, { texto: 'Tacos', votos: new Set(['host-1', 'u2']) }],
  },
  notas: { texto: 'dirección: calle Falsa 123', por: 'Ana', en: ANTES },
  reaccionUltima: new Map([['u2', Date.now()]]),
};

/* ------------------------ serializar (sin Sets crudos) ------------------ */
const json = JSON.parse(JSON.stringify(serializarSala(sala))); // debe poder serializarse
ok(json.code === 'TEST01' && json.name === 'Sala persistente', 'la sala se serializa a JSON');
ok(json.queue.length === 1 && !('votes' in json.queue[0]), 'la cola se guarda sin los votos (Set)');
ok(json.playback.position > 40, 'la posición de reproducción se resuelve al guardar');
ok(json.encuesta.opciones[1].votos.length === 2, 'los votos de la encuesta salen como lista');
ok(json.encuesta.opciones[0].texto === 'Pizza', 'las opciones conservan el texto');
ok(json.notas.texto.includes('calle Falsa'), 'las notas se guardan');
ok(json.plugins.notas === false, 'los flags de plugins se guardan');
ok(!('users' in json), 'no se guardan usuarios (no hay conexión al reiniciar)');

/* --------------------------- guardar (con rebote) ----------------------- */
const mapa = new Map([[sala.code, sala]]);
iniciar(mapa);
notificar();
ok(!existsSync(ARCHIVO), 'el guardado espera al rebote (1,2 s)');
await espera(1600);
ok(existsSync(ARCHIVO), 'se creó data/salas-test.json');
ok(!existsSync(`${ARCHIVO}.tmp`), 'la escritura es atómica (sin .tmp final)');

/* ---------------------------- volver a cargar -------------------------- */
const cargadas = await cargarSalas();
ok(cargadas.size === 1 && cargadas.has('TEST01'), 'la sala vuelve a cargar con su código');
const r = cargadas.get('TEST01');

ok(r.users instanceof Map && r.users.size === 0, 'arranca sin usuarios conectados');
ok(r.ownerToken === 'token-secreto', 'el token del anfitrión se conserva (para recuperar el rol)');
ok(r.controlPolicy === 'everyone', 'los permisos se conservan');
ok(r.hostId === 'host-1', 'se recuerda quién era anfitrión');
ok(r.queue.length === 1 && r.queue[0].title === 'Never Gonna Give You Up', 'la cola se restaura con título y fuente');
ok(r.queue[0].votes instanceof Set, 'cada item de la cola vuelve a tener su Set de votos');
ok(r.playback.ref === 'dQw4w9WgXcQ' && r.playback.playing === true, 'sigue en reproducción');
ok(r.playback.position >= 40 && r.playback.updatedAt >= Date.now() - 1500,
  `la posición se congeló en el guardado (${r.playback.position.toFixed(1)} s)`);
ok(r.encuesta && r.encuesta.pregunta === '¿Pizza o tacos?', 'la encuesta vuelve');
ok(r.encuesta.opciones[1].votos instanceof Set && r.encuesta.opciones[1].votos.size === 2,
  'los votos vuelven como Set');
ok(r.notas.texto.includes('calle Falsa'), 'las notas vuelven');
ok(r.plugins.notas === false && r.plugins.encuestas === true, 'los flags de plugins vuelven');
ok(r.skipVotes instanceof Set && r.reaccionUltima instanceof Map, 'contenedores de apoyo creados');
ok(r.chat.length === 1 && r.chat[0].text === 'hola', 'el historial de chat vuelve');
ok(r.plugins && typeof r.plugins === 'object', 'catálogo/estado de plugins operativo');

/* ------------------- archivo corrupto no rompe el arranque ------------- */
writeFileSync(ARCHIVO, '{esto no es json');
ok((await cargarSalas()).size === 0, 'un archivo corrupto no lanza: se empieza vacío');

/* ------------------- limpieza de salas abandonadas ---------------------- */
const hace25h = Date.now() - 25 * 3600 * 1000;
const hace1h = Date.now() - 3600 * 1000;
writeFileSync(ARCHIVO, JSON.stringify({ salas: [
  { code: 'VACIA0', name: 'vacía y vieja', lastSeen: hace25h, queue: [], playback: { ref: null }, chat: [] },
  { code: 'VIEJA01', name: 'vieja con vídeo', lastSeen: hace25h, queue: [], playback: { ref: 'abc', fuente: 'youtube' }, chat: [] },
  { code: 'NUEVA01', name: 'vacía pero reciente', lastSeen: hace1h, queue: [], playback: { ref: null }, chat: [] },
] }));
const trasLimpieza = await cargarSalas();
ok(!trasLimpieza.has('VACIA0'), 'una sala vacía y abandonada (+24 h) no se restaura');
ok(trasLimpieza.has('VIEJA01'), 'una sala con vídeo en cola/reproducción sí se restaura');
ok(trasLimpieza.has('NUEVA01'), 'una sala vacía pero reciente se restaura');

/* --------------------------- guardarYa inmediato ------------------------ */
iniciar(mapa);
await guardarYa();
const trasSalida = JSON.parse(readFileSync(ARCHIVO, 'utf8'));
ok(trasSalida.salas.length === 1 && trasSalida.salas[0].code === 'TEST01', 'guardarYa escribe al instante (Ctrl+C)');

rmSync(ARCHIVO, { force: true });

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
setTimeout(() => process.exit(fallos ? 1 : 0), 300);
