/**
 * Catálogo de plugins de sala.
 *
 * Cada plugin declara:
 *   id, nombre, descripcion      → se envían al cliente para el panel del anfitrión
 *   inicializar(room)            → estado por sala
 *   manejar(ctx)                 → procesa mensajes; devuelve true si el mensaje era suyo
 *   serializar(room)             → porción del estado que ven todos los clientes
 *
 * ctx = { room, user, msg, enviar, broadcast, esAnfitrion, puedeControlar }
 *
 * Para añadir un plugin nuevo: crea el objeto aquí y añádelo al array.
 * No hace falta tocar el resto del servidor.
 */
const MAX_TEXTO = 2000;

const limitar = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const encuestas = {
  id: 'encuestas',
  nombre: 'Encuestas',
  descripcion: 'Pregunta a la sala y ve los votos en vivo',
  inicializar(room) {
    room.encuesta = null;
  },
  manejar({ room, user, msg, enviar, broadcast }) {
    if (msg.type === 'poll.create') {
      const pregunta = limitar(msg.pregunta, 140);
      const opciones = (Array.isArray(msg.opciones) ? msg.opciones : [])
        .map((o) => limitar(o, 60))
        .filter(Boolean)
        .slice(0, 6);
      if (!pregunta || opciones.length < 2) {
        enviar(user.ws, { type: 'error', message: 'La encuesta necesita pregunta y al menos 2 opciones.' });
        return true;
      }
      if (room.encuesta && !room.encuesta.cerrada) {
        enviar(user.ws, { type: 'error', message: 'Ya hay una encuesta activa; ciérrala antes.' });
        return true;
      }
      room.encuesta = {
        id: `enc_${Date.now().toString(36)}`,
        pregunta,
        opciones: opciones.map((texto) => ({ texto, votos: new Set() })),
        creador: { id: user.id, name: user.name },
        creadaEn: Date.now(),
        cerrada: false,
      };
      broadcast();
      return true;
    }

    if (msg.type === 'poll.vote') {
      const enc = room.encuesta;
      if (!enc || enc.cerrada) {
        enviar(user.ws, { type: 'error', message: 'No hay encuesta activa.' });
        return true;
      }
      const idx = Number(msg.index);
      const op = enc.opciones[idx];
      if (!op) {
        enviar(user.ws, { type: 'error', message: 'Opción inválida.' });
        return true;
      }
      for (const otra of enc.opciones) {
        if (otra !== op) otra.votos.delete(user.id);
      }
      if (op.votos.has(user.id)) op.votos.delete(user.id);
      else op.votos.add(user.id);
      // el cliente necesita saber su propio voto (el estado solo lleva recuentos)
      const mio = enc.opciones.findIndex((o) => o.votos.has(user.id));
      enviar(user.ws, { type: 'plugin', plugin: 'encuestas', accion: 'miVoto', index: mio, encuestaId: enc.id });
      broadcast();
      return true;
    }

    if (msg.type === 'poll.close') {
      const enc = room.encuesta;
      if (!enc) return true;
      const esSuyo = enc.creador.id === user.id;
      if (!esSuyo) {
        enviar(user.ws, { type: 'error', message: 'Solo quien creó la encuesta (o el anfitrión) la cierra.' });
        return true;
      }
      enc.cerrada = true;
      broadcast();
      return true;
    }
    return false;
  },
  serializar(room) {
    const enc = room.encuesta;
    if (!enc) return { activa: false };
    const total = enc.opciones.reduce((n, o) => n + o.votos.size, 0);
    return {
      activa: true,
      id: enc.id,
      pregunta: enc.pregunta,
      cerrada: enc.cerrada,
      creador: enc.creador.name,
      creadorId: enc.creador.id,
      total,
      opciones: enc.opciones.map((o) => ({ texto: o.texto, votos: o.votos.size })),
    };
  },
};

const notas = {
  id: 'notas',
  nombre: 'Notas compartidas',
  descripcion: 'Un bloc de texto compartido por toda la sala',
  inicializar(room) {
    room.notas = { texto: '', por: null, en: null };
  },
  manejar({ room, user, msg, enviar, puedeControlar, broadcast }) {
    if (msg.type !== 'notes.set') return false;
    if (!puedeControlar) {
      enviar(user.ws, { type: 'error', message: 'Solo quien controla edita las notas.' });
      return true;
    }
    room.notas = { texto: String(msg.texto ?? '').slice(0, MAX_TEXTO), por: user.name, en: Date.now() };
    broadcast();
    return true;
  },
  serializar(room) {
    return { texto: room.notas.texto, por: room.notas.por, en: room.notas.en };
  },
};

const reacciones = {
  id: 'reacciones',
  nombre: 'Reacciones',
  descripcion: 'Emojis que vuelan sobre el vídeo',
  inicializar(room) {
    room.reaccionUltima = new Map(); // userId -> timestamp
  },
  manejar({ room, user, msg, enviar, broadcast }) {
    if (msg.type !== 'reaction') return false;
    const permitidos = ['👏', '😂', '🔥', '😮', '🍿', '❤️', '💀', '😭'];
    const emoji = String(msg.emoji || '');
    if (!permitidos.includes(emoji)) return true;
    const ahora = Date.now();
    if (ahora - (room.reaccionUltima.get(user.id) || 0) < 700) return true; // anti-spam
    room.reaccionUltima.set(user.id, ahora);
    broadcast({ type: 'reaccion', emoji, userId: user.id, name: user.name });
    return true;
  },
  serializar() {
    return { activa: true };
  },
};

const MAX_VOZ = 12; // aviso de malla: cada persona habla con todas las demás

const voz = {
  id: 'voz',
  nombre: 'Voz',
  descripcion: 'Habla en tiempo real (micrófono) con los que estén en el canal',
  inicializar(room) {
    room.voz = new Map(); // userId -> { silenciado, hablando, desde }
  },
  manejar({ room, user, msg, enviar, broadcast }) {
    if (msg.type === 'voz.join') {
      if (room.voz.size >= MAX_VOZ) {
        enviar(user.ws, { type: 'error', message: `El canal de voz está lleno (${MAX_VOZ}).` });
        return true;
      }
      if (room.voz.has(user.id)) return true;
      room.voz.set(user.id, { silenciado: false, hablando: false, desde: Date.now() });
      // el que entra es quien inicia las conexiones WebRTC: sin conflictos
      broadcast({ type: 'voz.lista', nuevo: user.id, participantes: [...room.voz.keys()] });
      broadcast(); // el estado compartido actualiza los iconos de micrófono
      return true;
    }

    if (msg.type === 'voz.leave') {
      if (room.voz.delete(user.id)) {
        broadcast({ type: 'voz.lista', nuevo: null, participantes: [...room.voz.keys()] });
        broadcast();
      }
      return true;
    }

    if (msg.type === 'voz.mute') {
      const v = room.voz.get(user.id);
      if (!v) return true;
      v.silenciado = Boolean(msg.silenciado);
      broadcast(); // cambia poco: va en el estado, no en un mensaje aparte
      return true;
    }

    if (msg.type === 'voz.habla') {
      // parpadeo de "está hablando": va ligero, no ensucia el estado completo
      broadcast({ type: 'voz.habla', userId: user.id, hablando: !!msg.hablando });
      return true;
    }

    if (msg.type === 'voz.senales') {
      // señalización WebRTC (offer/answer/candidatos ICE) reenviada al destinatario
      const destino = room.users.get(String(msg.para || ''));
      if (!destino || !room.voz.has(user.id)) return true;
      const carga = {};
      if (msg.sdp) carga.sdp = msg.sdp;
      if (msg.ice) carga.ice = msg.ice;
      enviar(destino.ws, { type: 'voz.senales', de: user.id, ...carga });
      return true;
    }

    return false;
  },
  serializar(room) {
    return {
      participantes: [...room.voz].map(([id, v]) => ({
        id,
        silenciado: v.silenciado,
        desde: v.desde,
      })),
    };
  },
};

export const plugins = [encuestas, notas, reacciones, voz];

export const catalogo = plugins.map(({ id, nombre, descripcion }) => ({ id, nombre, descripcion }));

export function inicializar(room) {
  room.plugins = Object.fromEntries(plugins.map((p) => [p.id, true]));
  for (const p of plugins) p.inicializar(room);
}

export function manejar(ctx) {
  const pid = ctx.pluginId;
  if (!pid || !ctx.room.plugins?.[pid]) return false;
  for (const p of plugins) if (p.id === pid && p.manejar(ctx)) return true;
  return false;
}

/** Mapa de tipo de mensaje → plugin responsable. */
export const TIPOS_PLUGIN = {
  'poll.create': 'encuestas',
  'poll.vote': 'encuestas',
  'poll.close': 'encuestas',
  'notes.set': 'notas',
  reaction: 'reacciones',
  'voz.join': 'voz',
  'voz.leave': 'voz',
  'voz.mute': 'voz',
  'voz.habla': 'voz',
  'voz.senales': 'voz',
};

export function serializar(room) {
  const salida = {};
  for (const p of plugins) salida[p.id] = p.serializar(room);
  return salida;
}
