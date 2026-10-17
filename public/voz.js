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
  voces: new Map(),       // clave -> { ctx, analizador, buf } para "está hablando"
  hablando: false,
};

let enviar = () => {};
let miId = null;

function iniciarVoz({ enviar: env, miId: id }) {
  enviar = env || enviar;
  miId = id || miId;
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
  voz.streamLocal = stream;
  voz.activa = true;
  voz.silenciado = false;
  medirVoz(stream, null);
  enviar({ type: 'voz.join' });
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
      const hablando = rms > 0.06;
      if (userId) {
        marcarHablando(userId, hablando);
      } else if (hablando !== voz.hablando) {
        voz.hablando = hablando;
        enviar({ type: 'voz.habla', hablando });
      }
      requestAnimationFrame(paso);
    };
    paso();
  } catch {}
}

function marcarHablando(userId, hablando) {
  document.querySelectorAll(`[data-user="${userId}"]`).forEach((el) => el.classList.toggle('hablando', !!hablando));
}

window.YTwinsVoz = {
  iniciarVoz, activarVoz, salirVoz, alternarMicro, alMensaje, alEstado,
  estado: () => ({
    activa: voz.activa,
    silenciado: voz.silenciado,
    conexiones: voz.conexiones.size,
    estados: [...voz.conexiones.values()].map((c) => c.connectionState),
    audios: voz.audios.size,
    hablando: voz.hablando,
  }),
};
})();
