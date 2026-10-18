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
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Si el servidor de la sala define TURN_URLS (JSON), se añaden esos relays.
 * El TURN es lo único que conecta cuando la red es muy restrictiva o cuando
 * dos equipos están en la misma wifi y los candidatos "mDNS" no se resuelven.
 *   TURN_URLS=[{"urls":"turn:mi-servidor:3478","username":"u","credential":"p"}]
 */
async function cargarTurn() {
  try {
    const r = await fetch('/api/turn');
    if (!r.ok) return;
    const { servidores } = await r.json();
    if (Array.isArray(servidores) && servidores.length) {
      ICE_SERVIDORES.push(...servidores);
      console.info('voz: servidores TURN añadidos', servidores.length);
    }
  } catch {}
}

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
  bloqueado: false,       // el navegador impide reproducir el audio remoto
  capa: null,             // <div> donde se cuelgan los <audio> remotos
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
let alAviso = () => {};   // avisa de problemas de conexión (fallo / recuperada)

function iniciarVoz({ enviar: env, miId: id, alCambiar: cb, alAviso: av }) {
  enviar = env || enviar;
  miId = id || miId;
  if (cb) alCambiar = cb;
  if (av) alAviso = av;
  if (!voz.capa) voz.capa = document.getElementById('capa-audio');
  cargarTurn();
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

/**
 * Pasa el micrófono por un nodo de ganancia antes de enviarlo.
 *
 * OJO: un AudioContext en PAUSA hace que su MediaStreamDestination devuelva
 * silencio, y el otro dispositivo no oye nada aunque el micro esté "activado".
 * Por eso esperamos a que arranque de verdad y, si no arranca, mandamos el
 * audio tal cual (sin ganancia) antes que mandarlo mudo.
 */
async function prepararSalida(stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== 'running') {
      await ctx.resume().catch(() => {});
      // un poco de margen: resume() es asíncrono
      for (let i = 0; i < 6 && ctx.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    }
    if (ctx.state !== 'running') {
      voz._sinGanancia = true;
      return stream;
    }
    const fuente = ctx.createMediaStreamSource(stream);
    const ganancia = ctx.createGain();
    ganancia.gain.value = voz.ganancia;
    const destino = ctx.createMediaStreamDestination();
    fuente.connect(ganancia);
    ganancia.connect(destino);
    const pista = destino.stream.getAudioTracks()[0];
    if (!pista || pista.readyState !== 'live') {
      voz._sinGanancia = true;
      return stream;
    }
    voz._nodoGanancia = { ctx, ganancia };
    voz._sinGanancia = false;
    return destino.stream;
  } catch {
    voz._sinGanancia = true;
    return stream; // si falla, se manda el audio tal cual
  }
}

/**
 * Micrófonos disponibles.
 *
 * Antes de conceder permiso el navegador esconde los nombres y a veces casi
 * todos los dispositivos, así que devolvemos también los que aún no tienen
 * etiqueta (como "Micrófono 3") para que se puedan elegir sin adivinar.
 */
async function dispositivos() {
  try {
    const todos = await navigator.mediaDevices.enumerateDevices();
    const entradas = todos.filter((d) => d.kind === 'audioinput');
    return entradas.map((d, i) => ({
      id: d.deviceId,
      nombre: d.label || `Micrófono ${i + 1} (sin nombre)`,
      porDefecto: d.deviceId === 'default',
      enUso: d.deviceId === 'communications',
    }));
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
  const saliente = await prepararSalida(nuevo);
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
  voz.streamLocal = await prepararSalida(stream);
  voz.activa = true;
  voz.silenciado = false;
  medirVoz(stream, null); // se mide el micrófono original (antes de la ganancia)
  enviar({ type: 'voz.join' });
  alCambiar();
  return { ok: true, sinGanancia: voz._sinGanancia };
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
    // algunos navegadores entregan la pista sin "streams": la reconstruimos
    const flujo = e.streams?.[0] || new MediaStream([e.track]);
    reproducirRemoto(userId, flujo);
  };
  c.onconnectionstatechange = () => {
    // diagnóstico: si la voz no llega, se avisa en vez de quedarse en silencio
    if (c.connectionState === 'failed') {
      voz.conexiones.delete(userId);
      alAviso(userId, 'fallo');
    } else if (c.connectionState === 'connected') {
      alAviso(userId, 'ok');
    }
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

/**
 * Suena el audio de una persona.
 *
 * Si el navegador bloquea el autoplay (o el elemento no suena por lo que sea),
 * NO nos quedamos en silencio: avisamos para que un clic lo arranque.
 */
function reproducirRemoto(userId, flujo) {
  let audio = voz.audios.get(userId);
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('data-user', userId);
    // en el DOM: hay navegadores que no reproducen elementos sueltos
    voz.capa.appendChild(audio);
    voz.audios.set(userId, audio);
  }
  audio.srcObject = flujo;
  const p = audio.play();
  if (p && p.catch) {
    p.then(() => { voz.bloqueado = false; }).catch(() => {
      voz.bloqueado = true;
      alAviso(userId, 'sin-sonido');
    });
  }
  medirVoz(flujo, userId);
}

/** Tras un clic del usuario reintentamos: el gesto destranca el audio bloqueado. */
function reintentarAudio() {
  if (!voz.bloqueado) return;
  let pendientes = 0;
  for (const audio of voz.audios.values()) {
    if (!audio.srcObject) continue;
    pendientes++;
    const p = audio.play();
    if (p && p.then) p.then(() => { if (--pendientes === 0) { voz.bloqueado = false; } }).catch(() => { pendientes--; });
    else pendientes--;
  }
  if (pendientes === 0) voz.bloqueado = false;
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
 * Radiografía del audio: dice si el micro envía, si hay conexiones y en qué
 * estado está cada una. Es lo que hay que mirar cuando "no se oye nada".
 */
async function diagnostico() {
  const pistas = [];
  const pista = (t, v) => pistas.push((v ? '✓' : '✗') + ' ' + t);

  pista('HTTPS (obligatorio para el micro)', window.isSecureContext);
  pista('getUserMedia disponible', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  pista('RTCPeerConnection disponible', typeof RTCPeerConnection !== 'undefined');

  const local = voz.streamLocal?.getAudioTracks?.()[0];
  pista('pista local viva' + (local ? ` (${local.label || local.readyState})` : ''), !!(local && local.readyState === 'live'));
  pista('pista local conmutada a silencio', !voz.silenciado);
  pista('nivel de entrada (0-1)', (voz.nivel ?? 0) > 0.01 ? 'hay señal, el micro funciona' : 'cero: nadie suena en tu micrófono');
  pista('audio remoto bloqueado por el navegador', !voz.bloqueado);
  pista('conexiones abiertas', voz.conexiones.size > 0);

  const peers = [...voz.conexiones.entries()].map(([id, c]) => {
    const cands = c.getStats ? null : null;
    return `  · ${(estadoNombre(id) || id.slice(0, 6))}: conexión=${c.connectionState} ICE=${c.iceConnectionState} senal=${c.signalingState}`;
  });
  if (!peers.length) pistas.push('  (no hay ninguna conexión todavía: el otro tiene que entrar en el canal)');

  return { texto: pistas.join('\n') + (peers.length ? '\n' + peers.join('\n') : ''), peers: peers.length };
}

function estadoNombre(id) {
  const li = document.querySelector(`[data-user="${id}"] .titulo`);
  return li ? li.textContent.replace(' (tú)', '') : null;
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
  reintentarAudio, diagnostico,
  ajustes: () => ({ ...ajustes.datos }),
  aplicarAjustes: (a) => {
    Object.assign(ajustes.datos, a || {});
    ajustes.guardar();
    Object.assign(voz, a || {});
  },
  nivel: () => voz.nivel,
  bloqueado: () => voz.bloqueado,
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
