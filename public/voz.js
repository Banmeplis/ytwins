/**
 * YTwins — voz en tiempo real.
 *
 * Malla de WebRTC (peer a peer): cada persona del canal manda su audio
 * directamente a las demás; el servidor de la sala solo hace de "señalero"
 * reenviando ofertas/respuestas y candidatos ICE.
 *
 * Regla para no liarse con conexiones simultáneas:
 *   - quien ENTRA al canal crea la oferta hacia cada uno de los demás;
 *   - los que ya estaban solo contestan. Nunca hay ofertas cruzadas.
 *
 * Uso (desde app.js):
 *   iniciarVoz({ enviar, miId })
 *   activarVoz() → { ok, error? }
 *   salirVoz(), alternarMicro()
 *   alMensaje(msg)         para los 'voz.*' del servidor
 *   alEstado(participantes) sincroniza al reconectar o al cambiar el permiso
 *
 * Todo va dentro de una IIFE a propósito: los scripts clásicos comparten el
 * ámbito global, así que cualquier `let/const` de aquí pisaría al de app.js.
 */
(function () {
const ICE_SERVIDORES = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const voz = {
  activa: false,
  silenciado: false,
  streamLocal: null,      // MediaStream del micrófono
  conexiones: new Map(),  // userId -> RTCPeerConnection
  audios: new Map(),      // userId -> HTMLAudioElement
  pendientes: new Map(),  // userId -> candidatos ICE que aún no tienen remoto
  voces: new Map(),       // clave -> { ctx, analizador } para "está hablando"
  hablantes: new Set(),   // quién tiene la palabra ahora mismo
  hablando: false,
  // ajustes del micrófono (los elige quien habla)
  microfonoId: '',        // id del dispositivo elegido ('' = el del sistema)
  sensibilidad: 0.06,     // umbral de voz (RMS) para considerarte "hablando"
  ganancia: 1,            // ganancia de entrada (1 = normal)
  ptt: false,             // hablar solo mientras se mantenga pulsado
  nivel: 0,               // nivel actual 0..1, para el medidor
  _nodoGanancia: null,
};

let enviar = () => {};
let miId = null;
let alCambiar = () => {};  // avisa a la interfaz para que repinte el botón

function iniciarVoz({ enviar: env, miId: id, alCambiar: cb }) {
  enviar = env || enviar;
  miId = id || miId;
  if (cb) alCambiar = cb;
}

/* --------------------------- ajustes del micro -------------------------- */

const CLAVE_AJUSTES = 'yr-voz-ajustes';
const ajustes = (() => {
  let guardado = {};
  try { guardado = JSON.parse(localStorage.getItem(CLAVE_AJUSTES) || '{}') || {}; } catch {}
  return {
    datos: {
      microfonoId: typeof guardado.microfonoId === 'string' ? guardado.microfonoId : '',
      sensibilidad: Number(guardado.sensibilidad) || 0.06,
      ganancia: Number(guardado.ganancia) || 1,
      ptt: !!guardado.ptt,
    },
    guardar() {
      try { localStorage.setItem(CLAVE_AJUSTES, JSON.stringify(this.datos)); } catch {}
    },
  };
})();
Object.assign(voz, ajustes.datos); // se recalled al arrancar

/** Pasa el micrófono por un nodo de ganancia antes de enviarlo. */
function prepararSalida(stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const fuente = ctx.createMediaStreamSource(stream);
    const ganancia = ctx.createGain();
    ganancia.gain.value = voz.ganancia;
    const destino = ctx.createMediaStreamDestination();
    fuente.connect(ganancia);
    ganancia.connect(destino);
    voz._nodoGanancia = { ctx, ganancia };
    return destino.stream;
  } catch {
    return stream; // si falla, se manda el audio tal cual
  }
}

/** Micrófonos disponibles (solo los nombra el navegador tras conceder permiso). */
async function dispositivos() {
  try {
    const todos = await navigator.mediaDevices.enumerateDevices();
    return todos
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, nombre: d.label || `Micrófono ${i + 1}` }));
  } catch {
    return [];
  }
}

/** Cambia de micrófono en caliente, sin salir del canal. */
async function cambiarMicro(id) {
  voz.microfonoId = id || '';
  if (!voz.activa) { alCambiar(); return { ok: true }; }
  let nuevo;
  try {
    nuevo = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    return { ok: false, error: 'No pude abrir ese micrófono.' };
  }
  const pista = nuevo.getAudioTracks()[0];
  pista.enabled = !voz.silenciado;
  const saliente = prepararSalida(nuevo);
  // sustituimos la pista en todas las conexiones ya abiertas
  for (const c of voz.conexiones.values()) {
    for (const s of c.getSenders()) {
      if (s.track && s.track.kind === 'audio') { try { await s.replaceTrack(saliente.getAudioTracks()[0]); } catch {} }
    }
  }
  if (voz.streamLocal) for (const t of voz.streamLocal.getTracks()) { try { t.stop(); } catch {} }
  voz.streamLocal = saliente;
  medirVoz(nuevo, null);
  alCambiar();
  return { ok: true };
}

function setSensibilidad(v) { voz.sensibilidad = Math.max(0.01, Math.min(0.4, Number(v) || 0.06)); }

function setGanancia(v) {
  voz.ganancia = Math.max(0.2, Math.min(4, Number(v) || 1));
  try { voz._nodoGanancia?.ganancia && (voz._nodoGanancia.ganancia.gain.value = voz.ganancia); } catch {}
}

function setPushToTalk(on) { voz.ptt = !!on; }

/** Con "hablar solo mientras pulsas": enciende/apaga el micro sin salir del canal. */
function hablarTemporal(on) {
  if (!voz.activa || !voz.streamLocal) return;
  for (const t of voz.streamLocal.getAudioTracks()) t.enabled = !!on;
  const silenciado = !on;
  if (silenciado === voz.silenciado) return;
  voz.silenciado = silenciado;
  enviar({ type: 'voz.mute', silenciado });
  alCambiar();
}

/* -------------------------------- micro --------------------------------- */

async function activarVoz() {
  if (voz.activa) return { ok: true };
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: 'Este navegador no da acceso al micrófono.' };
  }
  let stream;
  try {
    // eco cancellation es imprescindible: sin él se pisan las voces entre sí
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (e) {
    const negado = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
    return {
      ok: false,
      error: negado
        ? 'Permitiste el micrófono para poder hablar.'
        : 'No encontré ningún micrófono.',
    };
  }
  voz.streamLocal = prepararSalida(stream);
  voz.activa = true;
  voz.silenciado = false;
  medirVoz(stream, null); // se mide el micrófono original (antes de la ganancia)
  enviar({ type: 'voz.join' });
  alCambiar();
  return { ok: true };
}

function salirVoz() {
  if (voz.activa) enviar({ type: 'voz.leave' });
  cerrarTodo();
}

function cerrarTodo() {
  for (const c of voz.conexiones.values()) { try { c.close(); } catch {} }
  voz.conexiones.clear();
  for (const a of voz.audios.values()) { try { a.pause(); a.srcObject = null; a.remove(); } catch {} }
  voz.audios.clear();
  voz.pendientes.clear();
  for (const v of voz.voces.values()) { try { v.ctx.close(); } catch {} }
  voz.voces.clear();
  if (voz.streamLocal) for (const t of voz.streamLocal.getTracks()) { try { t.stop(); } catch {} }
  voz.streamLocal = null;
  voz.activa = false;
  voz.silenciado = false;
  voz.hablando = false;
  voz.nivel = 0;
  alCambiar();
}

function alternarMicro() {
  if (!voz.activa || !voz.streamLocal) return false;
  voz.silenciado = !voz.silenciado;
  for (const t of voz.streamLocal.getAudioTracks()) t.enabled = !voz.silenciado;
  enviar({ type: 'voz.mute', silenciado: voz.silenciado });
  return voz.silenciado;
}

/* ---------------------------- conexiones P2P ----------------------------- */

function conexion(userId) {
  let c = voz.conexiones.get(userId);
  if (c) return c;
  c = new RTCPeerConnection({ iceServers: ICE_SERVIDORES });
  c.onicecandidate = (e) => {
    if (e.candidate) enviar({ type: 'voz.senales', para: userId, ice: e.candidate.toJSON() });
  };
  c.ontrack = (e) => {
    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {}); // si el navegador lo bloquea, el botón 🎙️ ya dio el gesto
    voz.audios.set(userId, audio);
    medirVoz(e.streams[0], userId);
  };
  c.onconnectionstatechange = () => {
    if (c.connectionState === 'failed' || c.connectionState === 'closed') voz.conexiones.delete(userId);
  };
  if (voz.streamLocal) for (const t of voz.streamLocal.getTracks()) c.addTrack(t, voz.streamLocal);
  voz.conexiones.set(userId, c);
  return c;
}

async function alMensaje(msg) {
  if (msg.type === 'voz.lista') {
    const otros = (msg.participantes || []).filter((id) => id !== miId);
    if (!voz.activa) return; // alguien entró/salió y yo ni estoy en el canal
    if (msg.nuevo === miId) {
      for (const id of otros) await ofrecerA(id);
    }
    for (const id of [...voz.conexiones.keys()]) {
      if (!otros.includes(id)) cerrarConexion(id);
    }
    return;
  }

  if (msg.type === 'voz.habla') {
    marcarHablando(msg.userId, msg.hablando);
    return;
  }

  if (msg.type === 'voz.senales') {
    if (!voz.activa) return;
    const de = msg.de;
    const c = conexion(de);
    try {
      if (msg.sdp) {
        await c.setRemoteDescription(msg.sdp);
        for (const cand of voz.pendientes.get(de) || []) {
          try { await c.addIceCandidate(cand); } catch {}
        }
        voz.pendientes.delete(de);
        if (msg.sdp.type === 'offer') {
          const resp = await c.createAnswer();
          await c.setLocalDescription(resp);
          enviar({ type: 'voz.senales', para: de, sdp: c.localDescription });
        }
      } else if (msg.ice) {
        if (c.remoteDescription) await c.addIceCandidate(msg.ice).catch(() => {});
        else {
          const lista = voz.pendientes.get(de) || [];
          lista.push(msg.ice);
          voz.pendientes.set(de, lista);
        }
      }
    } catch { /* conexión a medias: se ignora y se reintenta al siguiente evento */ }
  }
}

function cerrarConexion(userId) {
  try { voz.conexiones.get(userId)?.close(); } catch {}
  voz.conexiones.delete(userId);
  const a = voz.audios.get(userId);
  if (a) { try { a.pause(); a.srcObject = null; a.remove(); } catch {} }
  voz.audios.delete(userId);
  voz.pendientes.delete(userId);
  voz.hablantes.delete(userId);
  marcarHablando(userId, false);
}

async function ofrecerA(userId) {
  const c = conexion(userId);
  try {
    const of = await c.createOffer({ offerToReceiveAudio: true });
    await c.setLocalDescription(of);
    enviar({ type: 'voz.senales', para: userId, sdp: c.localDescription });
  } catch {}
}

/** Al reconectar o cambiar el permiso: la lista del servidor manda. */
function alEstado(participantes) {
  const ids = (participantes || []).map((p) => p.id);
  if (!voz.activa) return;
  if (!ids.includes(miId)) {
    // el servidor se reinició y perdimos el sitio: volvemos a entrar solos
    enviar({ type: 'voz.join' });
    return;
  }
  for (const id of [...voz.conexiones.keys()]) if (!ids.includes(id)) cerrarConexion(id);
}

/* ------------------ "está hablando" (resaltado en la lista) -------------- */

function medirVoz(stream, userId) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const fuente = ctx.createMediaStreamSource(stream);
    const analizador = ctx.createAnalyser();
    analizador.fftSize = 512;
    fuente.connect(analizador);
    const buf = new Uint8Array(analizador.frequencyBinCount);
    const clave = userId || '__yo__';
    voz.voces.set(clave, { ctx, analizador });
    const paso = () => {
      if (!voz.voces.has(clave)) return;
      analizador.getByteFrequencyData(buf);
      let suma = 0;
      for (const v of buf) suma += v * v;
      const rms = Math.sqrt(suma / buf.length) / 255;
      const hablando = rms > voz.sensibilidad;
      if (!userId) {
        voz.nivel = rms; // sirve para el medidor de las opciones
        if (hablando !== voz.hablando) {
          voz.hablando = hablando;
          enviar({ type: 'voz.habla', hablando });
        }
      } else {
        marcarHablando(userId, hablando);
      }
      requestAnimationFrame(paso);
    };
    paso();
  } catch {}
}

function marcarHablando(userId, hablando) {
  document.querySelectorAll(`[data-user="${userId}"]`).forEach((el) => el.classList.toggle('hablando', !!hablando));
  centrarVoz(userId, hablando);
}

/**
 * "Centrar la voz": el que habla se oye al frente y los demás se suavizan un poco.
 * Cuando nadie habla, todo vuelve a su nivel normal.
 */
function centrarVoz(userId, hablando) {
  voz.hablantes = hablando
    ? new Set([...voz.hablantes, userId])
    : new Set([...voz.hablantes].filter((id) => id !== userId));
  for (const [id, audio] of voz.audios) {
    // nivel 1 para quien habla, 0.55 para el resto; sin nadie hablando: todos a 1
    audio.volume = voz.hablantes.size === 0 ? 1 : (voz.hablantes.has(id) ? 1 : 0.55);
  }
}

window.YTwinsVoz = {
  iniciarVoz, activarVoz, salirVoz, alternarMicro, alMensaje, alEstado,
  centrar: centrarVoz,
  dispositivos, cambiarMicro, setSensibilidad, setGanancia, setPushToTalk, hablarTemporal,
  ajustes: () => ({ ...ajustes.datos }),
  aplicarAjustes: (a) => {
    Object.assign(ajustes.datos, a || {});
    ajustes.guardar();
    Object.assign(voz, a || {});
  },
  nivel: () => voz.nivel,
  estado: () => ({
    activa: voz.activa,
    silenciado: voz.silenciado,
    conexiones: voz.conexiones.size,
    estados: [...voz.conexiones.values()].map((c) => c.connectionState),
    audios: voz.audios.size,
    hablando: voz.hablando,
    hablantes: [...voz.hablantes],
    ptt: voz.ptt,
  }),
};
})();
