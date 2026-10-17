/**
 * Servidor de salas sincronizadas de YouTube (+Vimeo, Dailymotion y .mp4 directos).
 * HTTP (estáticos + /api/search) y WebSocket en el mismo puerto.
 *
 * Estado de reproducción autoritativo en el servidor:
 *   posición en vivo = playback.position + (now - playback.updatedAt) / 1000  si playing
 * Los clientes corrigen el desfase si supera UMBRAL_DESFASE_S.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { buscarVideos, obtenerMetadatos } from './fuentes.js';
import { catalogo, inicializar as inicializarPlugins, manejar as manejarPlugin, serializar as serializarPlugins, TIPOS_PLUGIN } from './plugins.js';
import { cargarSalas, iniciar as iniciarPersistencia, notificar as notificarPersistencia, guardarYa, guardarEmergencia, limpiar } from './persistencia.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);

const UMBRAL_DESFASE_S = 1.5;      // corrección de sincronización en clientes
const INTERVALO_SYNC_MS = 10_000;  // broadcast de sincronización periódico
const HISTORIAL_CHAT = 100;
const SALA_VACIA_TTL_MS = 30 * 60_000;
const MAX_TEXTO_CHAT = 500;
const MAX_TITULO = 140;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
const rooms = new Map(); // código -> room

/* ---------------------------------------------------------------- helpers */

const nuevoCodigo = () => {
  for (let intento = 0; intento < 50; intento++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return randomUUID().slice(0, 6).toUpperCase();
};

const esAnfitrion = (room, user) => user.id === room.hostId;
const puedeControlar = (room, user) =>
  esAnfitrion(room, user) || user.role === 'controller' || room.controlPolicy === 'everyone';

function posicionActual(room) {
  const pb = room.playback;
  if (!pb.ref) return 0;
  if (!pb.playing) return pb.position;
  return pb.position + (Date.now() - pb.updatedAt) / 1000;
}

function serializar(room) {
  return {
    type: 'state',
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    controlPolicy: room.controlPolicy,
    users: [...room.users.values()].map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      anfitrion: u.id === room.hostId,
    })),
    queue: room.queue.map((q) => ({
      id: q.id,
      fuente: q.fuente,
      ref: q.ref,
      url: q.url,
      title: q.title,
      canal: q.canal,
      thumbnail: q.thumbnail,
      duration: q.duration,
      addedBy: q.addedBy,
      votes: q.votes.size,
    })),
    playback: {
      fuente: room.playback.fuente,
      ref: room.playback.ref,
      url: room.playback.url,
      title: room.playback.title,
      thumbnail: room.playback.thumbnail,
      duration: room.playback.duration ?? null,
      playing: room.playback.playing,
      position: posicionActual(room),
      updatedAt: Date.now(),
      skipVotes: room.skipVotes.size,
    },
    plugins: { activos: room.plugins, catalogo, estado: serializarPlugins(room) },
    chat: room.chat.slice(-HISTORIAL_CHAT),
    serverTime: Date.now(),
  };
}

function emitir(room, msg = null) {
  notificarPersistencia(); // la sala cambió → se encola el guardado
  const payload = JSON.stringify(msg ?? serializar(room));
  for (const u of room.users.values()) {
    if (u.ws.readyState === 1) u.ws.send(payload);
  }
}

function emitirSync(room) {
  if (!room.playback.ref || !room.playback.playing) return;
  const payload = JSON.stringify({
    type: 'sync',
    playback: { ...room.playback, position: posicionActual(room), updatedAt: Date.now(), skipVotes: room.skipVotes.size },
    serverTime: Date.now(),
  });
  for (const u of room.users.values()) {
    if (u.ws.readyState === 1) u.ws.send(payload);
  }
}

const obtenerSala = (codigo) => rooms.get(String(codigo || '').toUpperCase().trim());

function empujarChat(room, user, texto) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTO_CHAT);
  if (!limpio) return;
  const ahora = Date.now();
  if (ahora - (user.ultimoChat || 0) < 400) return; // anti-spam
  user.ultimoChat = ahora;
  room.chat.push({ id: randomUUID(), userId: user.id, name: user.name, text: limpio, at: ahora });
  if (room.chat.length > HISTORIAL_CHAT) room.chat.splice(0, room.chat.length - HISTORIAL_CHAT);
}

function reproducir(room, item) {
  room.playback = {
    fuente: item.fuente,
    ref: item.ref,
    url: item.url,
    title: item.title,
    thumbnail: item.thumbnail,
    duration: item.duration || null,
    position: 0,
    playing: true,
    updatedAt: Date.now(),
  };
  room.skipVotes = new Set();
}

function pasarSiguiente(room) {
  const siguiente = room.queue.shift();
  if (siguiente) {
    reproducir(room, siguiente);
  } else {
    room.playback = { fuente: null, ref: null, url: null, title: null, thumbnail: null, duration: null, position: 0, playing: false, updatedAt: Date.now() };
    room.skipVotes = new Set();
  }
}

const enviar = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

/* ------------------------------------------------------- manejo de mensajes */

async function manejar(ws, room, user, msg) {
  const t = msg?.type;
  const anfitrion = esAnfitrion(room, user);
  const controla = puedeControlar(room, user);

  switch (t) {
    case 'ping':
      return enviar(ws, { type: 'pong' }); // latido: mantiene viva la sala

    case 'chat':
      empujarChat(room, user, msg.text);
      emitir(room);
      return;

    case 'queue.add': {
      const meta = await obtenerMetadatos(msg.videoId ?? msg.url);
      if (!meta) {
        return enviar(ws, { type: 'error', message: 'No reconozco ese enlace. Admito YouTube, Vimeo, Dailymotion y .mp4/.webm directos.' });
      }
      const repetido = room.queue.some((q) => q.ref === meta.ref) || room.playback.ref === meta.ref;
      if (repetido) return enviar(ws, { type: 'error', message: 'Ese vídeo ya está en la sala.' });
      const item = { id: randomUUID(), ...meta, title: meta.title.slice(0, MAX_TITULO), addedBy: user.name, votes: new Set() };
      if (msg.playNow && controla) {
        reproducir(room, item);
      } else {
        room.queue.push(item);
        if (!room.playback.ref) pasarSiguiente(room);
      }
      emitir(room);
      return;
    }

    case 'queue.remove': {
      if (!controla) return enviar(ws, { type: 'error', message: 'Solo quien controla puede quitar vídeos.' });
      room.queue = room.queue.filter((q) => q.id !== msg.id);
      emitir(room);
      return;
    }

    case 'queue.play': {
      if (!controla) return enviar(ws, { type: 'error', message: 'Solo quien controla puede cambiar de vídeo.' });
      const idx = room.queue.findIndex((q) => q.id === msg.id);
      if (idx < 0) return;
      const [item] = room.queue.splice(idx, 1);
      reproducir(room, item);
      emitir(room);
      return;
    }

    case 'queue.next': {
      if (!controla) return enviar(ws, { type: 'error', message: 'Solo quien controla puede pasar al siguiente.' });
      pasarSiguiente(room);
      emitir(room);
      return;
    }

    case 'playback': {
      if (!controla) return enviar(ws, { type: 'error', message: 'Solo quien controla puede pausar o buscar.' });
      if (!room.playback.ref) return;
      const ahora = Date.now();
      if (msg.action === 'play') {
        room.playback.position = Number(msg.time ?? posicionActual(room)) || 0;
        room.playback.playing = true;
      } else if (msg.action === 'pause') {
        room.playback.position = Number(msg.time ?? posicionActual(room)) || 0;
        room.playback.playing = false;
      } else if (msg.action === 'seek') {
        room.playback.position = Math.max(0, Number(msg.time) || 0);
      } else {
        return;
      }
      room.playback.updatedAt = ahora;
      emitir(room);
      return;
    }

    case 'skip.vote': {
      if (anfitrion || controla) {
        pasarSiguiente(room);
        return emitir(room);
      }
      if (room.skipVotes.has(user.id)) return;
      room.skipVotes.add(user.id);
      const noControlan = [...room.users.values()].filter((u) => !puedeControlar(room, u)).length;
      const umbral = Math.max(1, Math.ceil(noControlan / 2));
      if (room.skipVotes.size >= umbral) pasarSiguiente(room);
      emitir(room);
      return;
    }

    case 'policy': {
      if (!anfitrion) return enviar(ws, { type: 'error', message: 'Solo el anfitrión cambia los permisos.' });
      if (msg.value !== 'host' && msg.value !== 'everyone') return;
      room.controlPolicy = msg.value;
      emitir(room);
      return;
    }

    case 'role.set': {
      if (!anfitrion) return enviar(ws, { type: 'error', message: 'Solo el anfitrión cambia roles.' });
      const objetivo = room.users.get(msg.userId);
      if (!objetivo || objetivo.id === room.hostId) return;
      objetivo.role = msg.role === 'controller' ? 'controller' : 'member';
      emitir(room);
      return;
    }

    case 'kick': {
      if (!anfitrion) return enviar(ws, { type: 'error', message: 'Solo el anfitrión expulsa.' });
      const objetivo = room.users.get(msg.userId);
      if (!objetivo || objetivo.id === room.hostId) return;
      enviar(objetivo.ws, { type: 'kicked' });
      objetivo.ws.close();
      return;
    }

    case 'plugin.toggle': {
      if (!anfitrion) return enviar(ws, { type: 'error', message: 'Solo el anfitrión activa o desactiva plugins.' });
      const id = String(msg.id || '');
      if (!(id in room.plugins)) return;
      room.plugins[id] = Boolean(msg.on);
      emitir(room);
      return;
    }

    default:
      break;
  }

  // ¿lo gestiona un plugin?
  const pluginId = TIPOS_PLUGIN[t];
  if (pluginId && room.plugins && !room.plugins[pluginId]) {
    return enviar(ws, { type: 'error', message: 'Ese plugin está desactivado en la sala.' });
  }
  const atendido = manejarPlugin({
    room,
    user,
    msg,
    pluginId,
    enviar,
    broadcast: (m = null) => emitir(room, m),
    esAnfitrion: anfitrion,
    puedeControlar: controla,
  });
  if (!atendido) enviar(ws, { type: 'error', message: 'Mensaje desconocido.' });
}

/* --------------------------------------------------------------- WebSocket */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/search') {
    try {
      const items = await buscarVideos(url.searchParams.get('q'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, items }));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, salas: rooms.size }));
    return;
  }

  try {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('403');
      return;
    }
    const data = await readFile(file);
    const tipos = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, {
      'content-type': tipos[path.extname(file)] || 'application/octet-stream',
      // el JS del cliente cambia seguido: que el navegador nunca se quede con
      // una versión antigua (ni los usuarios tras un despliegue nuevo)
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let user = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return enviar(ws, { type: 'error', message: 'JSON inválido.' });
    }

    if (msg.type === 'join') {
      if (room) return;
      const codigo = String(msg.code || '').toUpperCase().trim();
      const nombre = String(msg.name || '').trim().slice(0, 24) || 'Invitado';
      room = obtenerSala(codigo);
      if (!room) return enviar(ws, { type: 'error', message: `No existe la sala ${codigo}.`, fatal: true });

      user = { id: randomUUID(), name: nombre, ws, role: 'member', joinedAt: Date.now() };
      // el creador recupera el rol si vuelve; si no hay anfitrión presente, lo hereda el recién llegado
      const esDuenio = Boolean(msg.token) && msg.token === room.ownerToken;
      const hayAnfitrion = [...room.users.values()].some((u) => u.id === room.hostId);
      if (esDuenio || !hayAnfitrion) room.hostId = user.id;
      room.users.set(user.id, user);
      enviar(ws, { type: 'joined', userId: user.id, code: room.code });
      // el voto propio de la encuesta activa no viaja en el estado compartido
      if (room.encuesta && !room.encuesta.cerrada) {
        const mio = room.encuesta.opciones.findIndex((o) => o.votos.has(user.id));
        enviar(ws, { type: 'plugin', plugin: 'encuestas', accion: 'miVoto', index: mio, encuestaId: room.encuesta.id });
      }
      emitir(room);
      return;
    }

    if (msg.type === 'create') {
      if (room) return;
      const codigo = nuevoCodigo();
      const ownerToken = randomUUID();
      room = {
        code: codigo,
        name: String(msg.name || 'Sala').slice(0, 40) || 'Sala',
        hostId: null,
        ownerToken,
        controlPolicy: 'host',
        users: new Map(),
        queue: [],
        playback: { fuente: null, ref: null, url: null, title: null, thumbnail: null, duration: null, position: 0, playing: false, updatedAt: Date.now() },
        skipVotes: new Set(),
        chat: [],
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };
      inicializarPlugins(room);
      rooms.set(codigo, room);
      user = {
        id: randomUUID(),
        name: String(msg.userName || 'Anfitrión').trim().slice(0, 24) || 'Anfitrión',
        ws,
        role: 'member',
        joinedAt: Date.now(),
      };
      room.hostId = user.id;
      room.users.set(user.id, user);
      enviar(ws, { type: 'joined', userId: user.id, code: room.code, created: true, token: ownerToken });
      emitir(room);
      return;
    }

    if (!room || !user) return enviar(ws, { type: 'error', message: 'Únete a una sala primero.' });
    room.lastSeen = Date.now();
    await manejar(ws, room, user, msg);
  });

  ws.on('close', () => {
    if (!room || !user) return;
    room.users.delete(user.id);
    // nadie se lleva votos al desconectar (evita votos fantasma tras un refresco)
    room.skipVotes.delete(user.id);
    room.reaccionUltima?.delete(user.id);
    if (room.encuesta) for (const op of room.encuesta.opciones) op.votos.delete(user.id);
    // sale del canal de voz: sus conexiones WebRTC se quedaron sin sentido
    if (room.voz?.delete(user.id) && room.users.size > 0) {
      emitir(room, { type: 'voz.lista', nuevo: null, participantes: [...room.voz.keys()] });
    }

    if (room.users.size === 0) {
      room.lastSeen = Date.now();
      notificarPersistencia();
      return;
    }
    if (room.hostId === user.id) {
      // el anfitrión se fue: el que lleva más tiempo manda
      const sucesor = [...room.users.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (sucesor) room.hostId = sucesor.id;
    }
    emitir(room);
  });
});

/* --------------------------------------------------- tareas periódicas */

setInterval(() => {
  for (const room of rooms.values()) emitirSync(room);
  const ahora = Date.now();
  for (const [codigo, room] of rooms) {
    if (room.users.size === 0 && ahora - room.lastSeen > SALA_VACIA_TTL_MS) rooms.delete(codigo);
  }
}, INTERVALO_SYNC_MS);

// una vez por hora: borra de la base las salas vacías abandonadas
setInterval(() => { limpiar().catch(() => {}); }, 3600 * 1000).unref?.();

// guarda antes de morir (Ctrl+C, fin de proceso, kill)
const alSalir = async () => {
  await guardarYa();
  process.exit(0);
};
process.on('SIGINT', alSalir);
process.on('SIGTERM', alSalir);
process.on('exit', guardarEmergencia);

/* --------------------------------------------------------- arranque ----- */

// salas guardadas del arranque anterior (archivo local o PostgreSQL)
const restauradas = await cargarSalas();
for (const [codigo, sala] of restauradas) rooms.set(codigo, sala);
iniciarPersistencia(rooms);
if (restauradas.size) console.log(`  ${restauradas.size} sala(s) restaurada(s)`);

server.listen(PORT, () => {
  console.log(`\n  YTwins escuchando en http://localhost:${PORT}\n`);
});
