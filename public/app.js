/* YTwins — cliente */
const $ = (s) => document.querySelector(s);

let ws = null;
let estado = null;        // último estado completo del servidor
let yoId = null;
let codigo = null;
let expulsado = false;
let sesion = null;        // para reconectar y auto-reunirse
let nombreSesion = '';
let reintentos = 0;

let rep = null;           // reproductor multi-fuente (player.js)
let repFuente = null;
let refReproducido = null;
let ultimaAccionLocal = 0;

let resultados = [];
let miVoto = -1;
let buffersRecientes = 0;
let ultimaEncuestaVista = null; // para abrir "Extras" solo cuando llega una encuesta nueva
let ultimaCalidad = null;
let desfaseActual = 0;
let ultimoLocal = null;  // última posición local vista (para detectar seeks en la barra del vídeo)

const UMBRAL_SYNC = 1.5; // s: por debajo no se corrige
const SALTO_SEEK = 5;    // s: un salto local mayor en ~1 s solo puede ser un gesto en la barra del vídeo
const ESCALA = ['small', 'medium', 'large', 'hd720'];

/* ================================ utilidades ============================ */
const toast = (txt, err = false) => {
  const t = $('#toast');
  t.textContent = txt;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 3200);
};

const mmss = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const conectado = () => ws && ws.readyState === WebSocket.OPEN;
const enviar = (obj) => conectado() && ws.send(JSON.stringify(obj));

function yo() { return estado?.users.find((u) => u.id === yoId); }
function soyAnfitrion() { return estado && yoId === estado.hostId; }
function puedoControlar() {
  if (!estado) return false;
  return soyAnfitrion() || yo()?.role === 'controller' || estado.controlPolicy === 'everyone';
}
const pluginActivo = (id) => estado?.plugins?.activos?.[id] !== false;
const dPlugin = (id) => estado?.plugins?.estado?.[id];

const pintarConexion = (tipo, texto) => {
  const c = $('#chip-conexion');
  c.className = `chip estado ${tipo}`;
  c.textContent = texto;
};

/* ================================ red =================================== */
function conectar({ crear = false, code = '', name = '', userName = '', sala = '' } = {}) {
  sesion = { crear, code, sala, name };
  nombreSesion = userName || name;
  expulsado = false;
  reintentos = 0;
  abrirSocket();
}

function abrirSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reintentos = 0;
    pintarConexion('ok', 'conectado');
    if (sesion.crear) enviar({ type: 'create', name: sesion.sala, userName: nombreSesion });
    else enviar({ type: 'join', code: sesion.code, name: nombreSesion, token: sessionStorage.getItem('yr-' + sesion.code) || '' });
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'joined':
        yoId = msg.userId;
        codigo = msg.code;
        // desde aquí reconectamos a ESTA sala (aunque seamos el creador)
        sesion = { ...sesion, crear: false, code: msg.code };
        window.YTwinsVoz?.iniciarVoz({ enviar, miId: yoId });
        if (msg.token) sessionStorage.setItem('yr-' + msg.code, msg.token);
        sessionStorage.setItem('yr-ultima', JSON.stringify({ code: msg.code, name: nombreSesion }));
        mostrarSala();
        break;

      case 'state':
        estado = msg;
        render();
        aplicarEstado();
        break;

      case 'sync':
        if (estado) {
          Object.assign(estado.playback, msg.playback);
          pintarTiempo();
          aplicarEstado(true);
        }
        break;

      case 'reaccion':
        animarReaccion(msg.emoji);
        break;

      case 'voz.habla':
        marcarHablando(msg.userId, msg.hablando);
        break;

      case 'voz.lista':
      case 'voz.senales':
        window.YTwinsVoz?.alMensaje(msg);
        break;

      case 'plugin':
        if (msg.plugin === 'encuestas' && msg.accion === 'miVoto') {
          miVoto = msg.index;
          renderEncuestas();
        }
        break;

      case 'error':
        if (msg.fatal) {
          sessionStorage.removeItem('yr-ultima');
          errorLobby(msg.message);
          cerrar();
        } else toast(msg.message, true);
        break;

      case 'kicked':
        expulsado = true;
        sessionStorage.removeItem('yr-ultima');
        toast('El anfitrión te expulsó de la sala.', true);
        cerrar();
        break;
    }
  };

  ws.onclose = () => {
    if (expulsado) return cerrar();
    if (!estado) return; // aún en el lobby
    reconectar();
  };
}

function reconectar() {
  // reintenta sin rendirse: un reinicio del servidor no debe perder la sala
  const espera = Math.min(10000, 1000 * 2 ** reintentos);
  reintentos++;
  pintarConexion('warn', `reconectando${reintentos > 1 ? ` (${reintentos})` : ''}…`);
  setTimeout(abrirSocket, espera);
}

function cerrar() {
  estado = null; yoId = null; codigo = null; expulsado = false;
  ultimaEncuestaVista = null;
  ultimoLocal = null;
  refReproducido = null;
  hablandoIds.clear();
  pintarAvisoVoz(false);
  window.YTwinsVoz?.salirVoz(); // apaga el micro y cierra conexiones al salir
  if (rep) { rep.destruir(); rep = null; repFuente = null; }
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
  $('#vista-sala').classList.remove('activa');
  $('#vista-lobby').classList.add('activa');
}

const errorLobby = (txt) => {
  const e = $('#lobby-error');
  e.textContent = txt;
  e.hidden = false;
};

function mostrarSala() {
  $('#vista-lobby').classList.remove('activa');
  $('#vista-sala').classList.add('activa');
  $('#sala-codigo').textContent = codigo;
}

/* ============================ reproductor =============================== */
function asegurarReproductor(fuente) {
  if (rep && repFuente === fuente) return rep;
  if (rep) rep.destruir();
  repFuente = fuente;
  rep = crearReproductor(fuente, $('#player'), {
    accionLocal: alAccionLocal,
    terminar: () => { if (puedoControlar()) enviar({ type: 'queue.next' }); },
    buffer: (activo) => {
      if (activo) {
        buffersRecientes = Math.min(3, buffersRecientes + 1);
        aplicarCalidad();
      }
    },
    listo: () => aplicarEstado(),
    fallo: (mensaje) => toast(mensaje, true),
  });
  return rep;
}

function alAccionLocal(tipo, t) {
  if (!estado || !rep) return;
  if (Date.now() - ultimaAccionLocal < 900) return; // eco de lo que acabamos de aplicar
  if (!puedoControlar()) return;
  if (tipo === 'play' && !estado.playback.playing) {
    ultimaAccionLocal = Date.now();
    enviar({ type: 'playback', action: 'play', time: t });
  } else if (tipo === 'pause' && estado.playback.playing) {
    ultimaAccionLocal = Date.now();
    enviar({ type: 'playback', action: 'pause', time: t });
  }
}

const repListo = () => !!(rep && (typeof rep.listo === 'function' ? rep.listo() : rep.creado && rep.duracion() > 0));

/** Sincroniza el reproductor local con el estado autoritativo del servidor. */
function aplicarEstado(soloSync = false) {
  if (!estado) return;
  const pb = estado.playback;
  const hayVideo = !!pb.ref;

  $('#player-vacio').hidden = hayVideo;
  $('#btn-play').disabled = !hayVideo || !puedoControlar();
  $('#btn-siguiente').disabled = !hayVideo || !puedoControlar();
  $('#seek').disabled = !hayVideo || !puedoControlar();
  $('#aviso-control').hidden = !(hayVideo && !puedoControlar());

  if (!hayVideo) {
    refReproducido = null;
    // el iframe se quedaba sonando aunque la pantalla dijera "sin reproducción"
    if (rep) { try { rep.pausar(); } catch {} }
    pintarTiempo();
    return;
  }

  const servidor = pb.position + (pb.playing ? (Date.now() - pb.updatedAt) / 1000 : 0);
  const ahora = Date.now();
  const accionNueva = ahora - ultimaAccionLocal < 900;

  // 1. cargar el vídeo si cambió (fuente o referencia)
  const clave = `${pb.fuente}:${pb.ref}`;
  if (refReproducido !== clave) {
    refReproducido = clave;
    ultimoLocal = null; // vídeo nuevo: no confundir el salto con un gesto
    ultimaAccionLocal = ahora;
    buffersRecientes = 0;
    try {
      asegurarReproductor(pb.fuente || 'youtube').cargar(pb, Math.max(0, pb.position)).catch((e) => toast('No pude abrir este vídeo: ' + e.message, true));
    } catch (e) {
      toast('No pude abrir este vídeo: ' + e.message, true);
    }
  }

  // 2. aplicar play/pausa del servidor (salvo que aquí acabemos de actuar)
  if (!accionNueva && repListo()) {
    const st = rep.estado;
    // OJO: si está en 'ended' NO se reinicia. Al acabar pedimos el siguiente
    // vídeo; volver a llamar a reproducir aquí arrancaba el final otra vez y se
    // oía la canción repetida con la imagen ya detenida.
    if (pb.playing && (st === 'paused' || st === 'idle')) {
      ultimaAccionLocal = ahora;
      rep.reproducir();
    } else if (!pb.playing && st === 'playing') {
      ultimaAccionLocal = ahora;
      rep.pausar();
    }
  }

  // 3. corregir desfase (o adoptar el seek del que controla)
  let desfase = 0;
  if (repListo()) {
    try {
      const local = rep.tiempo();
      desfase = Math.abs(local - servidor);
      if (desfase > UMBRAL_SYNC && !soloSync && !accionNueva) {
        const salto = ultimoLocal === null ? 0 : Math.abs(local - ultimoLocal);
        if (puedoControlar() && salto > SALTO_SEEK) {
          // el que controla movió la barra del propio vídeo: adoptar su posición
          ultimaAccionLocal = ahora;
          enviar({ type: 'playback', action: 'seek', time: local });
          desfase = 0;
        } else {
          ultimaAccionLocal = ahora;
          rep.buscar(servidor);
          desfase = 0;
        }
      }
    } catch {}
  }

  desfaseActual = desfase;
  pintarEstadoSync();

  pintarTiempo();
}

/** Rotulo el estado de sincronización (se refresca también en el tick de 1 s). */
function pintarEstadoSync() {
  const el = $('#estado-sync');
  if (!estado?.playback.ref) {
    el.textContent = 'Sin vídeo en reproducción';
    el.className = '';
  } else if (!repListo()) {
    el.textContent = 'Cargando reproductor…';
    el.className = '';
  } else if (desfaseActual > UMBRAL_SYNC) {
    el.textContent = `Desfase ${desfaseActual.toFixed(1)} s — ajustando…`;
    el.className = 'warn';
  } else {
    el.textContent = `Sincronizado ✓${puedoControlar() ? ' · controlas' : ''}`;
    el.className = 'ok';
  }
}

/** Tick de 1 s: detecta seek local (barra de YouTube/Vimeo/Dailymotion) y refresca HUD. */
setInterval(() => {
  if (!estado || !rep || !estado.playback.ref) { pintarEstadoSync(); pintarTiempo(); return; }

  const pb = estado.playback;
  const servidor = pb.position + (pb.playing ? (Date.now() - pb.updatedAt) / 1000 : 0);

  if (repListo()) {
    // recuerda el volumen que eligió el usuario (por si lo cambia a mano)
    if (!hablandoIds.size && typeof rep.leerVolumen === 'function') {
      const v = rep.leerVolumen();
      if (v !== null && v !== undefined && Math.abs(v - volAplicado) > 0.01) {
        volUsuario = v;
        volAplicado = v;
      }
    }
    const local = rep.tiempo();
    desfaseActual = Math.abs(local - servidor);
    const salto = ultimoLocal === null ? 0 : Math.abs(local - ultimoLocal);
    ultimoLocal = local;
    const esMio = Date.now() - ultimaAccionLocal < 1000;
    if (!esMio && puedoControlar() && salto > SALTO_SEEK && desfaseActual > UMBRAL_SYNC) {
      // el que controla movió la barra del propio vídeo: adoptar su posición
      ultimaAccionLocal = Date.now();
      enviar({ type: 'playback', action: 'seek', time: local });
      desfaseActual = 0;
    } else if (!esMio && desfaseActual > UMBRAL_SYNC) {
      // corrige cualquiera: el servidor es la referencia
      ultimaAccionLocal = Date.now();
      try { rep.buscar(servidor); } catch {}
      desfaseActual = 0;
    }
  }

  pintarEstadoSync();
  pintarTiempo();
}, 1000);

function pintarTiempo() {
  if (!estado) return;
  const pb = estado.playback;
  const servidor = pb.position + (pb.playing ? (Date.now() - pb.updatedAt) / 1000 : 0);
  const dur = (repListo() && rep.duracion()) || estado.playback.duration || 0;
  $('#tiempo').textContent = `${mmss(servidor)} / ${mmss(dur)}`;
  if (document.activeElement !== $('#seek')) $('#seek').value = dur ? (servidor / dur) * 100 : 0;
  $('#btn-play').textContent = pb.playing ? '⏸' : '▶';
  $('#votos').textContent = pb.skipVotes || 0;
  pintarAutoplay();
}

/** Si el navegador bloqueó el arranque automático, ofrezco un botón con gesto. */
function pintarAutoplay() {
  const el = $('#btn-autoplay');
  if (!el) return;
  const bloqueado = !!(
    estado?.playback.playing && rep && repListo() && (rep.estado === 'idle' || rep.estado === 'ended')
  );
  el.hidden = !bloqueado;
}

/* ========================= calidad automática =========================== */
function calidadSugerida() {
  const c = navigator.connection;
  const et = c?.effectiveType;
  const down = c?.downlink ?? 10;
  let q = 'large';
  if (et === 'slow-2g' || et === '2g' || down < 0.8) q = 'small';
  else if (et === '3g' || down < 2.5) q = 'medium';
  else if (down >= 8) q = 'hd720';
  if (buffersRecientes >= 2) q = ESCALA[Math.max(0, ESCALA.indexOf(q) - 1)];
  return q;
}

function aplicarCalidad() {
  const q = calidadSugerida();
  if (q === ultimaCalidad) return;
  ultimaCalidad = q;
  try { rep && rep.calidad(q); } catch {}
  $('#chip-calidad').textContent = `calidad auto: ${CALIDADES[q] || q}`;
}
setInterval(aplicarCalidad, 20000);

/* ============================== render ================================== */
function render() {
  if (!estado) return;
  $('#sala-nombre').textContent = estado.name || 'Sala';
  $('#sala-permisos').textContent = estado.controlPolicy === 'everyone' ? '👥 todos controlan' : '🔒 anfitrión controla';

  renderUsers();
  renderPermisos();
  renderPlugins();
  renderEncuestas();
  renderNotas();
  renderExtras();
  pintarBotonVoz();
  window.YTwinsVoz?.alEstado(dPlugin('voz')?.participantes || []);
  renderCola();
  renderResultados();
  renderChat();
  pintarTiempo();
  aplicarCalidad();
}

function renderUsers() {
  const ul = $('#lista-users');
  ul.innerHTML = '';
  $('#users-contador').textContent = estado.users.length;
  const enVoz = new Map((dPlugin('voz')?.participantes || []).map((p) => [p.id, p]));

  for (const u of estado.users) {
    const li = document.createElement('li');
    const esYo = u.id === yoId;
    li.dataset.user = u.id;
    if (hablandoIds.has(u.id)) li.classList.add('hablando');

    const nombre = document.createElement('span');
    nombre.className = 'titulo';
    nombre.textContent = u.name + (esYo ? ' (tú)' : '');

    const etiquetas = document.createElement('span');
    etiquetas.className = 'meta';
    const mic = enVoz.get(u.id);
    if (mic) etiquetas.innerHTML += `<span class="badge mic${mic.silenciado ? ' off' : ''}">${mic.silenciado ? '🔇' : '🎙️'}</span>`;
    if (u.anfitrion) etiquetas.innerHTML += '<span class="badge host">anfitrión</span>';
    else if (u.role === 'controller') etiquetas.innerHTML += '<span class="badge ctrl">controla</span>';

    li.append(nombre, etiquetas);

    if (soyAnfitrion() && !u.anfitrion) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = u.role === 'controller' ? 'Quitar control' : 'Dar control';
      btn.onclick = () => enviar({ type: 'role.set', userId: u.id, role: u.role === 'controller' ? 'member' : 'controller' });
      const kick = document.createElement('button');
      kick.className = 'btn';
      kick.textContent = '✕';
      kick.title = 'Expulsar';
      kick.onclick = () => { if (confirm(`¿Expulsar a ${u.name}?`)) enviar({ type: 'kick', userId: u.id }); };
      li.classList.add('accion'); // classList, no className: no borra "hablando"
      li.append(btn, kick);
    }
    ul.appendChild(li);
  }
}

function renderPermisos() {
  const caja = $('#permisos');
  caja.hidden = !soyAnfitrion();
  if (caja.hidden) return;
  caja.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.policy === estado.controlPolicy));
}

function renderPlugins() {
  const caja = $('#caja-plugins');
  const lista = $('#lista-plugins');
  caja.hidden = !soyAnfitrion() || !estado.plugins;
  if (caja.hidden) return;

  lista.innerHTML = '';
  for (const p of estado.plugins.catalogo) {
    const fila = document.createElement('div');
    fila.className = 'plugin-fila';

    const sw = document.createElement('button');
    sw.className = 'switch' + (estado.plugins.activos[p.id] ? ' on' : '');
    sw.title = `${p.nombre}: ${p.descripcion}`;
    sw.onclick = () => enviar({ type: 'plugin.toggle', id: p.id, on: !estado.plugins.activos[p.id] });

    const txt = document.createElement('div');
    txt.innerHTML = `<b>${p.nombre}</b><span class="desc">${p.descripcion}</span>`;

    fila.append(sw, txt);
    lista.appendChild(fila);
  }
}

/* ------------------------------ voz (micrófono) --------------------------- */
const vozPluginActivo = () => pluginActivo('voz');
const hablandoIds = new Set(); // quién tiene el micro abierto en este momento

/* --- Opciones de micrófono ------------------------------------------------ */

/** El slider va de 2 a 30; el número alto hace falta menos voz para detectar que hablas. */
function etiquetaSensibilidad(v) {
  if (v <= 3) return 'muy alta';
  if (v <= 5) return 'alta';
  if (v <= 9) return 'normal';
  if (v <= 15) return 'baja';
  if (v <= 22) return 'muy baja';
  return 'mínima';
}

function pintarOpcionesVoz() {
  const a = window.YTwinsVoz?.ajustes?.() || {};
  const sens = $('#in-sensibilidad');
  const gan = $('#in-ganancia');
  if (sens) sens.value = Math.round((a.sensibilidad ?? 0.06) * 100);
  if (gan) gan.value = Math.round((a.ganancia ?? 1) * 100);
  const ptt = $('#in-ptt');
  if (ptt) ptt.checked = !!a.ptt;
  $('#val-sensibilidad').textContent = etiquetaSensibilidad(Number(sens?.value));
  $('#val-ganancia').textContent = `${Math.round((a.ganancia ?? 1) * 100)} %`;
  pintarMedidor();
}

/** Rellena el desplegable con los micrófonos reales (el navegador solo los nombra con permiso). */
async function listarMicros() {
  const sel = $('#sel-micro');
  if (!sel) return;
  const lista = await window.YTwinsVoz?.dispositivos?.() || [];
  const elegido = window.YTwinsVoz?.ajustes?.().microfonoId || '';
  sel.innerHTML = '';
  const porDefecto = document.createElement('option');
  porDefecto.value = '';
  porDefecto.textContent = lista.length ? `Por defecto (${lista[0].nombre})` : 'El del sistema';
  sel.appendChild(porDefecto);
  for (const d of lista) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.nombre;
    sel.appendChild(o);
  }
  sel.value = elegido;
  if (sel.selectedIndex < 0) sel.value = lista[0]?.id || '';
}

/** Medidor de nivel: sirve para ver si el micro oye y si el umbral está bien. */
function pintarMedidor() {
  const barra = $('#medidor-barra');
  const texto = $('#medidor-texto');
  if (!barra) return;
  const v = window.YTwinsVoz?.estado?.();
  const nivel = window.YTwinsVoz?.nivel?.() || 0;
  barra.style.setProperty('--nivel', Math.min(100, Math.round(nivel * 140)) + '%');
  if (!v?.activa) {
    texto.textContent = 'micro cerrado';
    texto.classList.remove('medidor-habla');
  } else if (v.hablando) {
    texto.textContent = 'te oigo';
    texto.classList.add('medidor-habla');
  } else {
    texto.textContent = 'silencio';
    texto.classList.remove('medidor-habla');
  }
}

function conectarOpcionesVoz() {
  $('#btn-voz-opciones').onclick = () => { $('#opciones-voz').open = !$('#opciones-voz').open; };

  $('#sel-micro').onchange = async (e) => {
    const r = await window.YTwinsVoz.cambiarMicro(e.target.value);
    if (!r.ok) return toast(r.error, true);
    window.YTwinsVoz.aplicarAjustes({ microfonoId: e.target.value });
    toast('Micrófono cambiado');
  };

  $('#in-sensibilidad').oninput = (e) => {
    const v = Number(e.target.value) / 100;
    window.YTwinsVoz.setSensibilidad(v);
    window.YTwinsVoz.aplicarAjustes({ sensibilidad: v });
    pintarOpcionesVoz();
  };

  $('#in-ganancia').oninput = (e) => {
    const v = Number(e.target.value) / 100;
    window.YTwinsVoz.setGanancia(v);
    window.YTwinsVoz.aplicarAjustes({ ganancia: v });
    pintarOpcionesVoz();
  };

  $('#in-ptt').onchange = (e) => {
    window.YTwinsVoz.setPushToTalk(e.target.checked);
    window.YTwinsVoz.aplicarAjustes({ ptt: e.target.checked });
    pintarBotonVoz();
    if (e.target.checked && window.YTwinsVoz.estado().activa) window.YTwinsVoz.hablarTemporal(false);
  };

  // con "hablar solo mientras pulsado": mantener 🎙️ = hablar
  const mic = $('#btn-voz');
  mic.addEventListener('pointerdown', () => {
    if (window.YTwinsVoz.estado().ptt && window.YTwinsVoz.estado().activa) window.YTwinsVoz.hablarTemporal(true);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    mic.addEventListener(ev, () => {
      if (window.YTwinsVoz.estado().ptt && window.YTwinsVoz.estado().activa) window.YTwinsVoz.hablarTemporal(false);
    });
  }
  setInterval(pintarMedidor, 250);
}

/* --- Cuando alguien habla, el vídeo se aparta y la voz se centra --------- */
const VOL_ATENUADO = 0.2;  // el vídeo se queda al 20 % mientras haya voz
let volUsuario = 1;        // el volumen que había elegido (se recuerda)
let volAplicado = 1;       // el que realmente está sonando ahora
let volTemporizador = null;

/** Sube o baja el volumen del vídeo con un fundido corto (sin chasquidos). */
function fundirVolumen(objetivo, ms = 260) {
  if (!rep || typeof rep.volumen !== 'function') return;
  if (volTemporizador) clearTimeout(volTemporizador);
  const desde = volAplicado;
  const pasos = 6;
  if (Math.abs(objetivo - desde) < 0.01) {
    volAplicado = objetivo;
    return rep.volumen(objetivo);
  }
  let i = 0;
  const paso = () => {
    i++;
    const v = desde + (objetivo - desde) * (i / pasos);
    volAplicado = v;
    try { rep.volumen(v); } catch {}
    if (i < pasos) volTemporizador = setTimeout(paso, ms / pasos);
  };
  paso();
}

/** El vídeo solo se atenúa si está sonando; al callarse vuelve a su volumen. */
function atenuarVideo() {
  const hayVoz = hablandoIds.size > 0;
  const sonando = !!estado?.playback?.playing && repListo();
  const objetivo = hayVoz && sonando ? Math.min(volUsuario, VOL_ATENUADO) : volUsuario;
  if (Math.abs(objetivo - volAplicado) > 0.01) fundirVolumen(objetivo);
  pintarAvisoVoz(hayVoz && sonando);
}

/** Chipe sobre el vídeo: "Ana está hablando · vídeo al 20%". */
function pintarAvisoVoz(atenuado) {
  const el = $('#aviso-voz');
  if (!el) return;
  if (!atenuado) { el.hidden = true; return; }
  const nombres = [...hablandoIds]
    .map((id) => estado?.users.find((u) => u.id === id)?.name)
    .filter(Boolean);
  const quien = nombres.length === 0
    ? 'Alguien está hablando'
    : nombres.length === 1
      ? `${nombres[0]} está hablando`
      : `${nombres.length} personas hablan`;
  el.hidden = false;
  el.textContent = `🎙️ ${quien} · vídeo al ${Math.round(VOL_ATENUADO * 100)}%`;
}

/** "Está hablando": se guarda en un Set para que el resaltado sobreviva al redibujado. */
function marcarHablando(userId, hablando) {
  if (hablando) hablandoIds.add(userId);
  else hablandoIds.delete(userId);
  document.querySelectorAll(`[data-user="${userId}"]`).forEach((el) => el.classList.toggle('hablando', !!hablando));
  window.YTwinsVoz?.centrar(userId, hablando); // centra el que habla
  atenuarVideo();
}

function pintarBotonVoz() {
  const b = $('#btn-voz');
  if (!b) return;
  const v = window.YTwinsVoz?.estado?.() || { activa: false, silenciado: false };
  b.classList.toggle('on', v.activa);
  b.classList.toggle('silenciado', v.activa && v.silenciado);
  b.disabled = !vozPluginActivo();
  b.textContent = !vozPluginActivo() ? '🚫' : v.activa ? (v.silenciado ? '🔇' : '🎙️') : '🎙️';
  b.title = !vozPluginActivo()
    ? 'El anfitrión ha desactivado la voz en esta sala'
    : v.activa
      ? v.ptt
        ? 'Mantén pulsado para hablar · Shift+clic para salir del canal'
        : `Estás en el canal de voz · ${v.conexiones} conexión(es). Clic para silenciar, Shift+clic para salir.`
      : 'Entrar al canal de voz con tu micrófono';
}

async function entrarVoz() {
  const r = await window.YTwinsVoz.activarVoz();
  if (!r.ok) return toast(r.error, true);
  await listarMicros(); // tras el permiso ya salen los nombres reales
  pintarBotonVoz();
  pintarOpcionesVoz();
}

function alternarSalirVoz() {
  if (!window.YTwinsVoz?.estado?.().activa) return;
  window.YTwinsVoz.salirVoz();
  pintarBotonVoz();
}

/* ------------------------------ encuestas ------------------------------- */
function renderEncuestas() {
  const seccion = $('#seccion-encuestas');
  seccion.hidden = !pluginActivo('encuestas');
  if (seccion.hidden) return;

  const caja = $('#encuesta-activa');
  const form = $('#form-encuesta');
  const enc = dPlugin('encuestas');
  caja.innerHTML = '';

  // encuesta nueva en curso → desplegar "Extras" para que se vea
  const clave = enc?.activa && !enc.cerrada ? `${enc.creadorId}|${enc.pregunta}` : null;
  if (clave && clave !== ultimaEncuestaVista) {
    ultimaEncuestaVista = clave;
    $('#panel-extras').open = true;
  }

  if (!enc?.activa) {
    form.hidden = false;
    return;
  }
  form.hidden = !enc.cerrada; // encuesta abierta → sin formulario; cerrada → se puede abrir otra

  const q = document.createElement('p');
  q.className = 'poll-meta';
  q.textContent = enc.creador;
  const pregunta = document.createElement('h3');
  pregunta.textContent = enc.pregunta;
  caja.append(pregunta, q);

  const total = Math.max(1, enc.total);
  enc.opciones.forEach((o, i) => {
    const btn = document.createElement('button');
    btn.className = 'poll-btn' + (i === miVoto ? ' mio' : '');
    btn.innerHTML = `<span class="relleno"></span><span><b>${o.texto}</b><i>${o.votos} · ${Math.round((o.votos / total) * 100)}%</i></span>`;
    btn.querySelector('.relleno').style.width = `${(o.votos / total) * 100}%`;
    if (!enc.cerrada) btn.onclick = () => enviar({ type: 'poll.vote', index: i });
    caja.appendChild(btn);
  });

  const meta = document.createElement('p');
  meta.className = 'poll-meta';
  meta.textContent = enc.cerrada
    ? `Cerrada · ${enc.total} voto${enc.total === 1 ? '' : 's'}`
    : `${enc.total} voto${enc.total === 1 ? '' : 's'} · toca una opción`;
  caja.appendChild(meta);

  if (!enc.cerrada && (enc.creadorId === yoId || soyAnfitrion())) {
    const cerrar = document.createElement('button');
    cerrar.className = 'btn';
    cerrar.textContent = 'Cerrar encuesta';
    cerrar.onclick = () => enviar({ type: 'poll.close' });
    caja.appendChild(cerrar);
  }
}

/* -------------------------------- notas --------------------------------- */
function renderNotas() {
  const seccion = $('#seccion-notas');
  seccion.hidden = !pluginActivo('notas');
  if (seccion.hidden) return;

  const n = dPlugin('notas') || { texto: '' };
  const lectura = $('#notas-lectura');
  const edit = $('#in-notas');
  const btn = $('#btn-notas');

  if (document.activeElement !== edit) lectura.textContent = n.texto || '';
  edit.hidden = !puedoControlar();
  btn.hidden = !puedoControlar();
}

/* -------------------------------- extras -------------------------------- */
function renderExtras() {
  // el desplegable "Extras" solo aparece si tiene algo que mostrar
  const hayAlgo =
    !$('#caja-plugins').hidden || !$('#seccion-encuestas').hidden || !$('#seccion-notas').hidden;
  $('#panel-extras').hidden = !hayAlgo;
}

/* --------------------------------- cola --------------------------------- */
const NOMBRE_FUENTE = { youtube: 'YouTube', vimeo: 'Vimeo', dailymotion: 'Dailymotion', directo: 'Archivo' };

function nodoFuente(fuente) {
  const b = document.createElement('span');
  b.className = `badge-fuente ${fuente}`;
  b.textContent = NOMBRE_FUENTE[fuente] || fuente;
  return b;
}

function nodoThumb(item) {
  if (item.thumbnail) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.src = item.thumbnail;
    img.alt = '';
    img.onerror = () => { const d = document.createElement('div'); d.className = 'thumb'; d.textContent = '🎬'; img.replaceWith(d); };
    return img;
  }
  const d = document.createElement('div');
  d.className = 'thumb';
  d.textContent = '🎬';
  return d;
}

function renderCola() {
  const ul = $('#lista-cola');
  ul.innerHTML = '';
  $('#cola-contador').textContent = estado.queue.length;

  if (!estado.queue.length) {
    const li = document.createElement('li');
    li.className = 'vacio';
    li.textContent = 'La cola está vacía';
    ul.appendChild(li);
    return;
  }

  const controla = puedoControlar();
  estado.queue.forEach((q, i) => {
    const li = document.createElement('li');
    li.append(nodoThumb(q));

    const cuerpo = document.createElement('div');
    cuerpo.className = 'cuerpo-item';
    cuerpo.innerHTML = `<span class="titulo"></span><span class="meta"></span>`;
    cuerpo.querySelector('.titulo').textContent = `${i + 1}. ${q.title}`;
    cuerpo.querySelector('.meta').textContent = q.canal ? `${q.canal} · por ${q.addedBy}` : `por ${q.addedBy}`;
    li.append(cuerpo, nodoFuente(q.fuente));

    const abrir = document.createElement('a');
    abrir.className = 'btn';
    abrir.href = q.url;
    abrir.target = '_blank';
    abrir.rel = 'noopener';
    abrir.textContent = '↗';
    abrir.title = 'Abrir en su web';

    if (controla) {
      const play = document.createElement('button');
      play.className = 'btn';
      play.textContent = '▶';
      play.title = 'Reproducir ahora';
      play.onclick = () => enviar({ type: 'queue.play', id: q.id });
      const del = document.createElement('button');
      del.className = 'btn';
      del.textContent = '✕';
      del.title = 'Quitar';
      del.onclick = () => enviar({ type: 'queue.remove', id: q.id });
      li.className = 'accion';
      li.append(play, del, abrir);
    } else {
      li.className = 'accion';
      li.append(abrir);
    }
    ul.appendChild(li);
  });
}

/* ------------------------------ buscador -------------------------------- */
function avisoBuscar(txt, error = false) {
  const a = $('#aviso-buscar');
  a.textContent = txt || '';
  a.hidden = !txt;
  a.style.color = error ? '#ff8b9c' : '';
}

function renderResultados() {
  const ul = $('#lista-resultados');
  ul.innerHTML = '';
  const controla = puedoControlar();

  for (const r of resultados) {
    const li = document.createElement('li');
    li.className = 'accion';
    li.append(nodoThumb(r));

    const cuerpo = document.createElement('div');
    cuerpo.className = 'cuerpo-item';
    cuerpo.innerHTML = `<span class="titulo"></span><span class="meta"></span>`;
    cuerpo.querySelector('.titulo').textContent = r.title;
    cuerpo.querySelector('.meta').textContent = [r.canal, r.duration, r.views].filter(Boolean).join(' · ');
    li.append(cuerpo);

    const add = document.createElement('button');
    add.className = 'btn';
    add.textContent = '+ Cola';
    add.onclick = () => { enviar({ type: 'queue.add', videoId: r.url, title: r.title }); toast('Añadido a la cola'); };

    li.append(add);
    if (controla) {
      const ya = document.createElement('button');
      ya.className = 'btn primario';
      ya.textContent = '▶ Ver';
      ya.onclick = () => enviar({ type: 'queue.add', videoId: r.url, title: r.title, playNow: true });
      li.append(ya);
    }
    ul.appendChild(li);
  }
}

/* --------------------------------- chat --------------------------------- */
function renderChat() {
  const box = $('#lista-chat');
  const cercaDelFondo = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
  box.innerHTML = '';
  for (const m of estado.chat) {
    const div = document.createElement('div');
    div.className = 'msg';
    const hora = new Date(m.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<span class="hora">${hora}</span><span class="autor"></span>`;
    div.querySelector('.autor').textContent = `${m.name}: `;
    div.insertAdjacentText('beforeend', m.text);
    box.appendChild(div);
  }
  if (cercaDelFondo || estado.chat.length <= 1) box.scrollTop = box.scrollHeight;
}

/* ------------------------------ reacciones ------------------------------ */
function animarReaccion(emoji) {
  const capa = $('#reacciones-vuelo');
  const s = document.createElement('span');
  s.className = 'reaccion-vuelo';
  s.textContent = emoji;
  s.style.left = 8 + Math.random() * 80 + '%';
  capa.appendChild(s);
  setTimeout(() => s.remove(), 2800);
}

/* ============================== eventos UI ============================== */
$('#btn-crear').onclick = () => {
  const nombre = $('#in-nombre').value.trim();
  if (!nombre) return errorLobby('Escribe tu nombre primero.');
  $('#lobby-error').hidden = true;
  conectar({ crear: true, sala: $('#in-nombre-sala').value.trim() || 'Sala', userName: nombre });
};

$('#btn-unirse').onclick = () => {
  const nombre = $('#in-nombre').value.trim();
  const code = $('#in-codigo').value.trim().toUpperCase();
  if (!nombre) return errorLobby('Escribe tu nombre primero.');
  if (code.length !== 6) return errorLobby('El código tiene 6 caracteres.');
  $('#lobby-error').hidden = true;
  conectar({ code, name: nombre });
};

$('#in-codigo').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-unirse').click(); });
$('#in-nombre').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-unirse').click(); });

$('#btn-salir').onclick = () => {
  sessionStorage.removeItem('yr-ultima');
  window.YTwinsVoz?.salirVoz();
  hablandoIds.clear();
  cerrar();
};

$('#btn-voz').onclick = (e) => {
  e.preventDefault(); // vive dentro del formulario del chat: que no lo envíe
  const v = window.YTwinsVoz?.estado?.();
  if (!vozPluginActivo()) return toast('El anfitrión ha desactivado la voz en esta sala.', true);
  if (!v?.activa) return entrarVoz();
  if (e.shiftKey) return alternarSalirVoz(); // salir del canal del todo
  if (v.ptt) return;                          // con "hablar solo mientras pulsas" manda mantener pulsado
  window.YTwinsVoz.alternarMicro();           // solo silenciar/activar
  pintarBotonVoz();
};

$('#btn-copiar').onclick = async () => {
  try { await navigator.clipboard.writeText(codigo); toast(`Código ${codigo} copiado`); }
  catch { toast(`Código: ${codigo}`); }
};

$('#form-chat').onsubmit = (e) => {
  e.preventDefault();
  const txt = $('#in-chat').value.trim();
  if (!txt) return;
  enviar({ type: 'chat', text: txt });
  $('#in-chat').value = '';
};

$('#form-cola').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#in-video').value.trim();
  if (!v) return;
  enviar({ type: 'queue.add', videoId: v });
  $('#in-video').value = '';
  toast('Añadido a la cola');
};

$('#form-buscar').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#in-buscar').value.trim();
  if (!q) return;
  avisoBuscar('Buscando…');
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const datos = await res.json();
    if (!datos.ok) throw new Error(datos.error || 'error');
    resultados = datos.items || [];
    avisoBuscar(resultados.length ? null : 'Sin resultados para esa búsqueda.');
    renderResultados();
  } catch (err) {
    avisoBuscar(`No pude buscar: ${err.message}. Puedes pegar el enlace directamente en la pestaña Cola.`, true);
  }
};

document.querySelectorAll('.pestana').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.pestana').forEach((x) => x.classList.toggle('on', x === b));
    $('#vista-buscar').hidden = b.dataset.pestana !== 'buscar';
    $('#vista-cola').hidden = b.dataset.pestana !== 'cola';
  };
});

$('#btn-play').onclick = () => {
  if (!puedoControlar() || !estado?.playback.ref) return;
  const pb = estado.playback;
  const t = pb.position + (pb.playing ? (Date.now() - pb.updatedAt) / 1000 : 0);
  enviar({ type: 'playback', action: pb.playing ? 'pause' : 'play', time: t });
};

$('#btn-siguiente').onclick = () => puedoControlar() && enviar({ type: 'queue.next' });

$('#btn-saltar').onclick = () => {
  if (!estado?.playback.ref) return;
  if (puedoControlar()) return enviar({ type: 'queue.next' });
  enviar({ type: 'skip.vote' });
  toast('Voto registrado');
};

// el navegador puede bloquear el autoplay: este botón aporta el gesto
$('#btn-autoplay').onclick = () => {
  if (!rep) return;
  ultimaAccionLocal = Date.now();
  try { rep.reproducir(); } catch {}
  setTimeout(pintarAutoplay, 600);
};

$('#seek').oninput = (e) => {
  if (!puedoControlar() || !repListo()) return;
  const dur = rep.duracion();
  $('#tiempo').textContent = `${mmss((e.target.value / 100) * dur)} / ${mmss(dur)}`;
};
$('#seek').onchange = (e) => {
  if (!puedoControlar() || !repListo()) return;
  const t = (e.target.value / 100) * rep.duracion();
  ultimaAccionLocal = Date.now();
  enviar({ type: 'playback', action: 'seek', time: t });
  try { rep.buscar(t); } catch {}
};

document.querySelectorAll('#permisos .chip').forEach((c) => {
  c.onclick = () => enviar({ type: 'policy', value: c.dataset.policy });
});

document.querySelectorAll('.emoji').forEach((b) => {
  b.onclick = () => { enviar({ type: 'reaction', emoji: b.dataset.e }); animarReaccion(b.dataset.e); };
});

$('#form-encuesta').onsubmit = (e) => {
  e.preventDefault();
  const pregunta = $('#in-encuesta').value.trim();
  const opciones = [...document.querySelectorAll('#form-encuesta .op')].map((i) => i.value.trim()).filter(Boolean);
  if (!pregunta || opciones.length < 2) return toast('La encuesta necesita pregunta y 2 opciones.', true);
  enviar({ type: 'poll.create', pregunta, opciones });
  $('#in-encuesta').value = '';
  document.querySelectorAll('#form-encuesta .op').forEach((i) => (i.value = ''));
};

$('#btn-notas').onclick = () => enviar({ type: 'notes.set', texto: $('#in-notas').value });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space' && estado?.playback.ref) { e.preventDefault(); $('#btn-play').click(); }
});

/* ============================ arranque ================================== */

// Opciones de micrófono (se recuerdan entre sesiones)
conectarOpcionesVoz();
pintarOpcionesVoz();
window.YTwinsVoz?.iniciarVoz({ enviar, miId, alCambiar: pintarBotonVoz });

// Latido: mantiene viva la conexión (y evita que el alojamiento duerma la app
// mientras hay gente en la sala). El servidor responde con un "pong" ignorado.
setInterval(() => { if (estado && conectado()) enviar({ type: 'ping' }); }, 4 * 60 * 1000);

(function autorejoin() {
  try {
    const guardado = JSON.parse(sessionStorage.getItem('yr-ultima') || 'null');
    if (!guardado?.code || !sessionStorage.getItem('yr-' + guardado.code)) return;
    $('#in-nombre').value = guardado.name || '';
    conectar({ code: guardado.code, name: guardado.name || 'Invitado' });
  } catch {}
})();
