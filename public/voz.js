/* ============================================================================
 * VOZ POR EL SERVIDOR (WebSockets)
 *
 * Todos los de la sala están conectados al MISMO WebSocket. El micrófono
 * viaja por ese cable y el servidor lo reparte al canal de voz. No hay
 * WebRTC: ni ICE, ni TURN, ni autoplay de tráfico de red. El navegador solo
 * reproduce el sonido local con WebAudio, y ese contexto se desbloquea con
 * el clic del botón de voz, así que no pide permiso de nuevo.
 *
 * Formato: mono, 16 kHz, int16; frames de ~110 ms por el WS en base64.
 * ========================================================================== */
(function () {
  'use strict';

  const $ = window.__yrQ || ((s) => document.querySelector(s));

  const ESERVID = 16000;   // Hz de envío
  const MARGEN = 0.14;     // colchón anti-entrecortado al sonar (segundos)
  const LIMITE_TEXTO = 8000; // tope del marco en caracteres base64
  const TAMANO_TANDA = 0.09; // segundos de audio por envío (~90 ms)

  /* ------------------------------- estado --------------------------------- */
  const voz = {
    activa: false,
    streamMicro: null,        // micrófono en crudo (getUserMedia)
    silenciado: false,        // 🔇 manual, o PTT suelto
    microfonoId: '',          // dispositivo elegido ('' = el del sistema)
    sensibilidad: 0.06,       // umbral de voz (RMS) para considerarte "hablando"
    ganancia: 1,              // ganancia de entrada (1 = normal)
    ptt: false,               // hablar solo mientras se mantenga pulsado
    nivel: 0,                 // nivel del micro 0..1 (medidor de opciones)
    nivelEnviado: 0,          // nivel de lo que SALE a los demás (post-ganancia)
    ctx: null,                // AudioContext único (reproducción)
    envioCtx: null,           // AudioContext de captura
    envioFuente: null,        // MediaStreamSource del micro
    envioGanancia: null,
    envioAnalizador: null,    // mide lo que de verdad sale
    envioBuf: null,
    envioSecuencia: 0,
    envioPendiente: [],       // muestrasint16 acumuladas por enviar
    vigor: null,              // AudioWorkletNode capturador
    reproductores: new Map(), // userId -> { ganancia, analizador, cola, programado, seq }
    hablantes: new Set(),
    hablando: false,
    voces: new Map(),         // bucles de medición por clave
    capa: null,               // (compatibilidad con la interfaz)
    bloqueado: false,         // el navegador impide el audio local
  };

  let enviar = () => {};
  let miId = null;
  let alCambiar = () => {};
  let alAviso = () => {};

  function iniciarVoz({ enviar: env, miId: id, alCambiar: cb, alAviso: av }) {
    enviar = env || enviar;
    miId = id || miId;
    if (cb) alCambiar = cb;
    if (av) alAviso = av;
    if (!voz.capa) voz.capa = document.getElementById('capa-audio');
  }

  /* ------------------------- contexto compartido --------------------------- */

  function contextoAudio() {
    if (!voz.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      voz.ctx = new Ctx();
      try {
        voz.ctx.addEventListener?.('statechange', () => {
          if (voz.ctx.state !== 'running') voz.ctx.resume().catch(() => {});
        });
      } catch {}
    }
    if (voz.ctx.state !== 'running') voz.ctx.resume().catch(() => {});
    return voz.ctx;
  }

  // cualquier gesto reactiva los contextos si el navegador los suspendió
  if (typeof document !== 'undefined') {
    for (const ev of ['pointerdown', 'keydown', 'touchend']) {
      document.addEventListener(ev, () => {
        if (voz.ctx && voz.ctx.state !== 'running') voz.ctx.resume().catch(() => {});
        if (voz.envioCtx && voz.envioCtx.state !== 'running') voz.envioCtx.resume().catch(() => {});
      }, true);
    }
  }

  /** Después de un clic: intenta subir los dos contextos y quita el aviso. */
  function reintentarAudio() {
    const a = contextoAudio();
    if (voz.envioCtx) voz.envioCtx.resume().catch(() => {});
    if (a) { voz.bloqueado = false; alAviso('__todos__', 'ok'); }
  }

  /* ------------------------- captura y envío ------------------------------- */

  const CODIGO_CAPTURADOR = `
    class Capturador extends AudioWorkletProcessor {
      constructor() { super(); this.retenido = new Float32Array(0); }
      process(entradas) {
        const s = entradas && entradas[0] && entradas[0][0];
        if (!s || !s.length) return true;
        const junto = new Float32Array(this.retenido.length + s.length);
        junto.set(this.retenido);
        junto.set(s, this.retenido.length);
        this.retenido = junto;
        if (this.retenido.length >= 2048) {
          this.port.postMessage(this.retenido.slice(0, 2048));
          this.retenido = this.retenido.slice(2048);
        }
        return true;
      }
    }
    registerProcessor('capturador', Capturador);

    // Solo para diagnóstico: cuenta cuántos bloques de audio le llegan de verdad
    class Contador extends AudioWorkletProcessor {
      constructor() { super(); this.n = 0; }
      process(entradas) {
        const s = entradas && entradas[0] && entradas[0][0];
        if (s && s.length) { this.n++; if (this.n % 10 === 0) this.port.postMessage(this.n); }
        return true;
      }
    }
    registerProcessor('contador', Contador);
  `;

  /** Baja a 16 kHz con promediado y convierte a int16 (con saturación). */
  function convertir(muestras, frecuenciaOrigen) {
    const paso = frecuenciaOrigen / ESERVID;
    const maxima = Math.max(0, Math.floor((muestras.length - 1) / paso));
    const salida = new Int16Array(maxima);
    for (let i = 0; i < maxima; i++) {
      const a = Math.floor(i * paso);
      const b = Math.min(muestras.length, Math.floor((i + 1) * paso) + 1);
      let s = 0;
      for (let j = a; j < b; j++) s += muestras[j];
      const v = Math.max(-1, Math.min(1, s / (b - a)));
      salida[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    return salida;
  }

  function aBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    const trozos = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      trozos.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    return btoa(trozos.join(''));
  }

  function deBase64(texto) {
    const crudo = atob(texto);
    const bytes = new Uint8Array(crudo.length);
    for (let i = 0; i < crudo.length; i++) bytes[i] = crudo.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  /** Monta micro → ganancia → worklet → WebSocket. */
  async function montarEnvio(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !window.AudioWorkletNode) throw new Error('Este navegador no soporta la captura moderna de audio.');
    if (!voz.envioCtx || voz.envioCtx.state === 'closed') voz.envioCtx = new Ctx();
    const ctx = voz.envioCtx;
    if (ctx.state !== 'running') {
      await ctx.resume().catch(() => {});
      for (let i = 0; i < 10 && ctx.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    }
    if (ctx.state !== 'running') throw new Error('El navegador suspendió el canal del micrófono.');
    try { voz.envioFuente?.disconnect?.(); } catch {}
    try { voz.envioGanancia?.disconnect?.(); } catch {}
    try { voz.envioAnalizador?.disconnect?.(); } catch {}
    try { voz.vigor?.disconnect?.(); } catch {}
    const fuente = ctx.createMediaStreamSource(stream);
    const ganancia = ctx.createGain();
    ganancia.gain.value = voz.ganancia;
    const anali = ctx.createAnalyser();
    anali.fftSize = 256;
    // el módulo del worklet hay que cargarlo ANTES de poder crear el nodo
    const url = URL.createObjectURL(new Blob([CODIGO_CAPTURADOR], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error('El navegador no cargó el capturador de audio (AudioWorklet).');
    }
    URL.revokeObjectURL(url);
    const worklet = new AudioWorkletNode(ctx, 'capturador');
    // OJO: un nodo cuya salida no va a ninguna parte puede dejar de procesarse
    // (el motor de audio recorta las ramas que no llegan a la salida), y el
    // capturador se quedaría mudo sin avisar. Lo colgamos de un silencio.
    const silencio = ctx.createGain();
    silencio.gain.value = 0;
    worklet.port.onmessage = (e) => recibirMarco(e.data, ctx.sampleRate);
    fuente.connect(ganancia);
    ganancia.connect(anali);     // aquí mide lo que de verdad sale
    ganancia.connect(worklet);   // y aquí viaja al servidor
    worklet.connect(silencio);
    silencio.connect(ctx.destination);
    voz.envioFuente = fuente;
    voz.envioGanancia = ganancia;
    voz.envioAnalizador = anali;
    voz.envioBuf = new Uint8Array(anali.frequencyBinCount);
    voz.envioPendiente = [];
    voz.envioSecuencia = 0;
    voz.vigor = worklet;
  }

  /** Cada marco del micro: baja a 16 kHz y se agrega a la cola de envío. */
  function recibirMarco(muestras, frecuenciaOrigen) {
    voz.marcosRecibidos = (voz.marcosRecibidos || 0) + 1;
    voz.ultimoLargo = muestras ? muestras.length : -1;
    if (!voz.activa || voz.silenciado) return;
    const convertido = convertir(muestras, frecuenciaOrigen);
    voz.ultimoConvertido = convertido.length;
    voz.envioPendiente.push(convertido);
    let largo = 0;
    for (const p of voz.envioPendiente) largo += p.length;
    voz.pendienteMuestras = largo;
    // mandamos tandas de ~90 ms para no saturar el servidor con paquetitos
    if (largo < ESERVID * TAMANO_TANDA) return;
    const todo = new Int16Array(largo);
    let en = 0;
    for (const p of voz.envioPendiente) { todo.set(p, en); en += p.length; }
    voz.envioPendiente = [];
    const datos = aBase64(todo);
    if (datos.length > LIMITE_TEXTO) return; // (no debería pasar: marco de 110 ms)
    enviar({ type: 'voz.audio', seq: voz.envioSecuencia++, datos });
  }

  /* --------------------------- recepción y reproduction ------------------- */

  /** Un participante del canal: prepara (si no estaba) su cadena de WebAudio. */
  function reproducirRemoto(userId) {
    const ctx = contextoAudio();
    if (!ctx) { voz.bloqueado = true; alAviso(userId, 'sin-sonido'); return null; }
    let r = voz.reproductores.get(userId);
    if (!r) {
      const ganancia = ctx.createGain();
      ganancia.gain.value = 1;
      const analizador = ctx.createAnalyser();
      analizador.fftSize = 512;
      ganancia.connect(analizador);
      ganancia.connect(ctx.destination);
      r = { ganancia, analizador, buf: new Uint8Array(analizador.frequencyBinCount), cola: [], programado: 0, seq: -1 };
      voz.reproductores.set(userId, r);
      // mide lo que de verdad suena de esta persona para marcar "está hablando"
      medirDesde({ analizador, buf: r.buf }, userId);
    }
    voz.bloqueado = false;
    alAviso(userId, 'ok');
    return r;
  }

  /** Llega un marco de alguien: a la cola, el bombeo lo programa. */
  function escuchar(userId, seq, datosBase64) {
    if (!voz.activa) return;
    if (userId === miId) return;
    const r = reproducirRemoto(userId);
    if (!r) return;
    let marco;
    try { marco = deBase64(datosBase64); } catch { return; }
    r.seq = seq;
    r.cola.push(marco);
    bombear();
  }

  let bombeo = null;

  function bombear() {
    if (bombeo) return;
    bombeo = setInterval(pasoDeBombear, 60);
  }

  /** Programa los marcos en la línea de tiempo del contexto, en orden y sin
   *  huecos: si la app volvió de un segundo plano y quedó atrás, resincroniza */
  function pasoDeBombear() {
    const ctx = voz.ctx;
    if (!voiceOn()) return;
    const ahora = ctx.currentTime;
    for (const r of voz.reproductores.values()) {
      if (r.programado && r.programado < ahora - 0.3) r.programado = 0;
      if (r.cola.length > 30) { r.cola.splice(0, r.cola.length - 8); r.programado = 0; }
      let cuando = Math.max(r.programado || ahora + MARGEN, ahora + 0.04);
      let suena = false;
      while (r.cola.length && cuando < ahora + 0.36) {
        const marco = r.cola.shift();
        const buffer = ctx.createBuffer(1, marco.length, ESERVID);
        const canal = buffer.getChannelData(0);
        for (let i = 0; i < marco.length; i++) canal[i] = marco[i] / 32768;
        const fuente = ctx.createBufferSource();
        fuente.buffer = buffer;
        fuente.connect(r.ganancia);
        fuente.start(cuando);
        cuando += marco.length / ESERVID;
        suena = true;
      }
      if (suena) r.programado = Math.max(r.programado || ahora, cuando);
      if (r.programado && r.programado < ahora) r.programado = 0;
    }
  }

  function voiceOn() {
    return voz.ctx && voz.ctx.state === 'running' && voz.reproductores.size > 0;
  }

  /* ------------------------------- ajustes -------------------------------- */

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
  Object.assign(voz, ajustes.datos);

  /** Micrófonos disponibles; los sin nombre se listan igualmente. */
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
    nuevo.getAudioTracks()[0].enabled = !voz.silenciado;
    try {
      await montarEnvio(nuevo);
      const anterior = voz.streamMicro;
      voz.streamMicro = nuevo;
      if (anterior && anterior !== nuevo) for (const t of anterior.getTracks()) { try { t.stop(); } catch {} }
    } catch {
      return { ok: false, error: 'No pude cambiar el micrófono en este momento.' };
    }
    medirVoz(nuevo, null);
    alCambiar();
    return { ok: true };
  }

  function setSensibilidad(v) { voz.sensibilidad = Math.max(0.01, Math.min(0.4, Number(v) || 0.06)); }

  function setGanancia(v) {
    voz.ganancia = Math.max(0.2, Math.min(4, Number(v) || 1));
    try { voz.envioGanancia && (voz.envioGanancia.gain.value = voz.ganancia); } catch {}
  }

  function setPushToTalk(on) { voz.ptt = !!on; }

  /** "Hablar solo mientras pulsas": enciende/apaga sin salir del canal. */
  function hablarTemporal(on) {
    if (!voz.activa || !voz.streamMicro) return;
    if (!!on === !voz.silenciado) return;
    voz.silenciado = !on;
    enviar({ type: 'voz.mute', silenciado: voz.silenciado });
    alCambiar();
  }

  /* ------------------------------- micro ---------------------------------- */

  async function activarVoz() {
    if (voz.activa) return { ok: true };
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, error: 'Este navegador no da acceso al micrófono.' };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const negado = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      return {
        ok: false,
        error: negado ? 'Permite el micrófono para poder hablar.' : 'No encontré ningún micrófono.',
      };
    }
    try {
      await montarEnvio(stream);
    } catch (e) {
      for (const t of stream.getTracks()) { try { t.stop(); } catch {} }
      return { ok: false, error: e?.message || 'El navegador no dejó iniciar el micro.' };
    }
    voz.streamMicro = stream;
    voz.activa = true;
    voz.silenciado = false;
    medirVoz(stream, null);
    vigilarSalida();
    enviar({ type: 'voz.join' });
    alCambiar();
    return { ok: true };
  }

  /* vigilante: el contexto de captura no puede dormirse, porque aunque el
     micro capture, el worklet quedaría mudo y los demás oirían nada */
  let vigiante = null;

  function vigilarSalida() {
    clearInterval(vigiante);
    vigiante = null;
    if (!voz.activa) return;
    vigiante = setInterval(() => {
      if (!voz.activa || !voz.envioCtx) return;
      if (voz.envioCtx.state !== 'running') voz.envioCtx.resume().catch(() => {});
    }, 1500);
  }

  function salirVoz() {
    if (voz.activa) enviar({ type: 'voz.leave' });
    clearInterval(vigiante); vigiante = null;
    clearInterval(bombeo); bombeo = null;
    cerrarTodo();
  }

  function cerrarTodo() {
    clearInterval(vigiante); vigiante = null;
    clearInterval(bombeo); bombeo = null;
    try { voz.envioFuente?.disconnect?.(); } catch {}
    try { voz.envioGanancia?.disconnect?.(); } catch {}
    try { voz.envioAnalizador?.disconnect?.(); } catch {}
    try { voz.vigor?.disconnect?.(); } catch {}
    for (const t of voz.streamMicro?.getTracks?.() || []) { try { t.stop(); } catch {} }
    voz.envioFuente = null;
    voz.envioGanancia = null;
    voz.envioAnalizador = null;
    voz.envioBuf = null;
    voz.vigor = null;
    voz.streamMicro = null;
    for (const id of [...voz.reproductores.keys()]) cerrarConexion(id);
    voz.reproductores.clear();
    voz.hablantes.clear();
    voz.voces.clear();
    voz.activa = false;
    voz.silenciado = false;
    voz.hablando = false;
    voz.nivel = 0;
    voz.nivelEnviado = 0;
    alCambiar();
  }

  function alternarMicro() {
    if (!voz.activa || !voz.streamMicro) return false;
    voz.silenciado = !voz.silenciado;
    enviar({ type: 'voz.mute', silenciado: voz.silenciado });
    return voz.silenciado;
  }

  function cerrarConexion(userId) {
    const r = voz.reproductores.get(userId);
    if (r) { try { r.ganancia.disconnect(); r.analizador.disconnect(); } catch {} }
    voz.reproductores.delete(userId);
    voz.hablantes.delete(userId);
    marcarHablando(userId, false);
  }

  /* --------------------------- mensajes del servidor ----------------------- */

  function alMensaje(msg) {
    if (msg.type === 'voz.lista') {
      const otros = new Set((msg.participantes || []).filter((id) => id !== miId));
      for (const id of [...voz.reproductores.keys()]) {
        if (!otros.has(id)) cerrarConexion(id);
      }
      for (const id of otros) reproducirRemoto(id);
      return;
    }
    if (msg.type === 'voz.audio') {
      escuchar(msg.de, msg.seq, msg.datos);
    }
  }

  /** Al reconectar: la lista del servidor manda; si faltamos, volvemos. */
  function alEstado(participantes) {
    const ids = (participantes || []).map((p) => p.id || p);
    if (!voz.activa) return;
    if (!ids.includes(miId)) {
      enviar({ type: 'voz.join' });
      return;
    }
    for (const id of [...voz.reproductores.keys()]) if (!ids.includes(id)) cerrarConexion(id);
  }

  /* -------------------- medición y "está hablando" ------------------------- */

  function medirVoz(stream, userId) {
    const ctx = contextoAudio() || new (window.AudioContext || window.webkitAudioContext)();
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const fuente = ctx.createMediaStreamSource(stream);
      const analizador = ctx.createAnalyser();
      analizador.fftSize = 512;
      fuente.connect(analizador);
      medirDesde({ fuente, analizador, buf: new Uint8Array(analizador.frequencyBinCount) }, userId);
    } catch {}
  }

  /** Mide el micro, mide lo que sale, y avisa de quién está hablando. */
  function medirDesde(nodo, userId) {
    const clave = userId || '__yo__';
    voz.voces.set(clave, nodo);
    const paso = () => {
      if (!voz.voces.has(clave)) return;
      nodo.analizador.getByteFrequencyData(nodo.buf);
      let suma = 0;
      for (const v of nodo.buf) suma += v * v;
      const rms = Math.sqrt(suma / nodo.buf.length) / 255;
      const hablando = rms > voz.sensibilidad && !voz.silenciado;
      if (!userId) {
        voz.nivel = rms;
        const A = voz.envioAnalizador;
        const B = voz.envioBuf;
        if (A && B) {
          A.getByteFrequencyData(B);
          let se = 0;
          for (const v of B) se += v * v;
          voz.nivelEnviado = voz.silenciado ? 0 : Math.sqrt(se / B.length) / 255;
        }
        if (hablando !== voz.hablando) {
          voz.hablando = hablando;
          enviar({ type: 'voz.habla', hablando });
        }
      } else {
        marcarHablando(userId, rms > voz.sensibilidad);
      }
      requestAnimationFrame(paso);
    };
    paso();
  }

  function marcarHablando(userId, hablando) {
    if (hablando) voz.hablantes.add(userId); else voz.hablantes.delete(userId);
    document.querySelectorAll(`[data-user="${userId}"]`).forEach((el) => el.classList.toggle('hablando', !!hablando));
    centrarVoz(userId, hablando);
  }

  function estadoNombre(id) {
    const li = document.querySelector(`[data-user="${id}"] .titulo`);
    return li ? li.textContent.replace(' (tú)', '') : null;
  }

  /** Sube a quien habla y suaviza al resto (con ganancia real). */
  function centrarVoz(userId, hablando) {
    voz.hablantes = hablando
      ? new Set([...voz.hablantes, userId])
      : new Set([...voz.hablantes].filter((id) => id !== userId));
    const nivel = (id) => (voz.hablantes.size === 0 ? 1 : voz.hablantes.has(id) ? 1 : 0.55);
    for (const r of voz.reproductores.values()) {
      try { r.ganancia.gain.value = 0.55; } catch {}
    }
    for (const id of voz.hablantes) {
      const r = voz.reproductores.get(id);
      if (r) { try { r.ganancia.gain.value = nivel(id); } catch {} }
    }
    if (voz.hablantes.size === 0) {
      for (const r of voz.reproductores.values()) { try { r.ganancia.gain.value = 1; } catch {} }
    }
  }

  /* ------------------------------ diagnóstico ------------------------------ */

  /** Radiografía de la voz: micro, envío real y estado de cada oyente. */
  function diagnostico() {
    const pistas = [];
    const pista = (t, v) => pistas.push((v ? '✓' : '✗') + ' ' + t);

    pista('HTTPS (obligatorio para el micro)', window.isSecureContext);
    pista('getUserMedia disponible', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    pista('captura moderna (AudioWorklet)', !!(window.AudioWorkletNode && (window.AudioContext || window.webkitAudioContext)));

    const micro = voz.streamMicro?.getAudioTracks?.()[0];
    pista('pista del micro viva' + (micro ? ` (${micro.label || micro.readyState})` : ''), !!(micro && micro.readyState === 'live'));
    pista('nivel del micro (0-1)', (voz.nivel ?? 0) > 0.01 ? 'hay señal, el micro funciona' : 'cero: nadie suena en tu micrófono');
    pista('nivel ENVIADO a los demás (0-1)',
      (voz.nivelEnviado ?? 0) > 0.005
        ? 'sale sonido de verdad'
        : (voz.activa && !voz.silenciado ? 'MUDO: toca la pantalla y reintenta el canal' : 'silenciado o parado'));
    pista('modo "mantén pulsado para hablar" (PTT)', !voz.ptt);
    pista('silencio con 🔇', !voz.silenciado);
    pista('canal de captura en marcha', voz.envioCtx?.state === 'running');
    pista('canal de reproducción en marcha', voz.ctx?.state === 'running');
    pista('oyentes activos sonando', voz.reproductores.size > 0);

    const peers = [...voz.reproductores.entries()].map(([id, r]) => {
      const cola = r.cola.length;
      const estado = cola > 0 || r.programado ? 'recibe audio' : 'sin marcos todavía';
      return `  · ${(estadoNombre(id) || id.slice(0, 6))}: ${estado} (cola=${cola})`;
    });
    if (!peers.length) pistas.push('  (nadie más está en el canal de voz todavía)');

    return { texto: pistas.join('\n') + (peers.length ? '\n' + peers.join('\n') : ''), peers: peers.length };
  }

  /** Diagnóstico de captura: comprueba si el worklet recibe bloques de audio. */
  async function depurar() {
    const salida = { pasos: [] };
    if (!voz.envioCtx || !voz.streamMicro) return { error: 'no hay canal de captura' };
    const ctx = voz.envioCtx;
    try {
      const url = URL.createObjectURL(new Blob([CODIGO_CAPTURADOR], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const nodo = new AudioWorkletNode(ctx, 'contador');
      const fuente = ctx.createMediaStreamSource(voz.streamMicro);
      const anali = ctx.createAnalyser();
      anali.fftSize = 512;
      const buf = new Uint8Array(anali.frequencyBinCount);
      fuente.connect(anali);
      fuente.connect(nodo);
      let bloques = 0;
      nodo.port.onmessage = () => { bloques++; };
      await new Promise((r) => setTimeout(r, 700));
      anali.getByteFrequencyData(buf);
      let suma = 0;
      for (const v of buf) suma += v * v;
      salida.pasos.push('bloques recibidos por el worklet: ' + bloques);
      salida.pasos.push('señal en el analizador: ' + (Math.sqrt(suma / buf.length) / 255).toFixed(3));
      try { fuente.disconnect(); nodo.disconnect(); anali.disconnect(); } catch {}
    } catch (e) {
      salida.pasos.push('error: ' + String(e));
    }
    return salida;
  }

  window.YTwinsVoz = {
    iniciarVoz, activarVoz, salirVoz, alternarMicro, alMensaje, alEstado,
    centrar: centrarVoz,
    dispositivos, cambiarMicro, setSensibilidad, setGanancia, setPushToTalk, hablarTemporal,
    reintentarAudio, diagnostico, depurar,
    ajustes: () => ({ ...ajustes.datos }),
    aplicarAjustes: (a) => {
      Object.assign(ajustes.datos, a || {});
      ajustes.guardar();
      Object.assign(voz, a || {});
    },
    nivel: () => voz.nivel,
    bloqueado: () => voz.bloqueado,
    detalle: () => ({
      secuenciaEnviada: voz.envioSecuencia,
      marcosRecibidos: voz.marcosRecibidos || 0,
      ultimoLargo: voz.ultimoLargo,
      ultimoConvertido: voz.ultimoConvertido,
      pendienteMuestras: voz.pendienteMuestras,
      estadoEnvio: voz.envioCtx ? voz.envioCtx.state : 'sin ctx',
      colaPendiente: voz.envioPendiente.length,
      oyentes: [...voz.reproductores.entries()].map(([id, r]) => ({
        id: String(id).slice(0, 6),
        cola: r.cola.length,
        seq: r.seq,
        programado: Math.round((r.programado || 0) * 100) / 100,
      })),
    }),
    estado: () => ({
      activa: voz.activa,
      silenciado: voz.silenciado,
      conexiones: voz.reproductores.size,   // participantes además de tú
      audios: voz.reproductores.size,
      hablando: voz.hablando,
      hablantes: [...voz.hablantes],
      ptt: voz.ptt,
      nivelEnviado: voz.nivelEnviado,
    }),
  };
})();
