/* Prueba de integración del protocolo de sala (sin navegador).
 * Los mensajes se acumulan en un búfer por conexión para que ninguna
 * espera pierda un mensaje que ya había llegado (dos frames en el mismo
 * chunk de red se emiten en el mismo tick). */
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://localhost:3000';
const buffers = new WeakMap();

function buf(ws) {
  let a = buffers.get(ws);
  if (!a) {
    a = [];
    ws.on('message', (raw) => a.push(raw.toString()));
    buffers.set(ws, a);
  }
  return a;
}

const esperar = (ws, tipo, ms = 6000) =>
  new Promise((res, rej) => {
    const a = buf(ws);
    const t = setTimeout(() => rej(new Error(`timeout esperando ${tipo}`)), ms);
    const ver = () => {
      const i = a.findIndex((x) => {
        try { return JSON.parse(x).type === tipo; } catch { return false; }
      });
      if (i < 0) return false;
      clearTimeout(t);
      const m = JSON.parse(a[i]);
      a.splice(0, i + 1); // cada mensaje se consume una sola vez
      res(m);
      return true;
    };
    if (ver()) return;
    const h = () => { if (ver()) ws.off('message', h); };
    ws.on('message', h);
  });

const cliente = () => new WebSocket(URL);
const abrir = (ws) => new Promise((res, rej) => { buf(ws); ws.on('open', res); ws.on('error', rej); });
const send = (ws, o) => ws.send(JSON.stringify(o));
const estado = (ws) => esperar(ws, 'state');
/** Vacía el búfer: evita que esperar() devuelva un mensaje viejo que aún no se consumió. */
const drenar = (ws) => { buf(ws).length = 0; };
/** Espera al estado cuyo último chat sea exactamente ese texto (evita carreras). */
const esperarChat = (ws, texto, ms = 6000) =>
  new Promise((res, rej) => {
    const a = buf(ws);
    const t = setTimeout(() => rej(new Error(`timeout esperando el chat "${texto}"`)), ms);
    const ver = () => {
      const i = a.findIndex((x) => {
        try { const m = JSON.parse(x); return m.type === 'state' && m.chat?.at(-1)?.text === texto; } catch { return false; }
      });
      if (i < 0) return false;
      clearTimeout(t);
      const m = JSON.parse(a[i]);
      a.splice(0, i + 1);
      res(m);
      return true;
    };
    if (ver()) return;
    const h = () => { if (ver()) ws.off('message', h); };
    ws.on('message', h);
  });

let fallos = 0;
const ok = (cond, nombre) => {
  console.log(`${cond ? '  PASS' : '✗ FAIL'}  ${nombre}`);
  if (!cond) fallos++;
};

const A = cliente();
await abrir(A);

// 1. crear sala
send(A, { type: 'create', name: 'Sala de prueba', userName: 'Ana' });
const joined = await esperar(A, 'joined');
ok(/^[A-Z2-9]{6}$/.test(joined.code), `sala creada con código ${joined.code}`);
let st = await estado(A);
ok(st.hostId === joined.userId, 'la creadora es anfitriona');
ok(st.plugins && st.plugins.catalogo.length === 4, 'catálogo de plugins publicado en el estado');
ok(st.plugins.catalogo.some((p) => p.id === 'voz'), 'el plugin de voz está en el catálogo');

// 2. segundo cliente se une
const B = cliente();
await abrir(B);
const estadoA = estado(A);
send(B, { type: 'join', code: joined.code, name: 'Beto' });
const joinedB = await esperar(B, 'joined');
st = await estadoA;
ok(st.users.length === 2, 'B se une y aparece en la lista (2 usuarios)');

// 3. chat
const esperaChat = estado(A);
send(B, { type: 'chat', text: '  hola    gente  ' });
st = await esperaChat;
const msg = st.chat.at(-1);
ok(msg && msg.text === 'hola gente' && msg.name === 'Beto', 'chat limpia espacios y guarda autor');

// 4. cola (pide metadatos a YouTube)
const e1 = estado(A);
send(B, { type: 'queue.add', videoId: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
st = await e1;
ok(st.playback.ref === 'dQw4w9WgXcQ', 'URL extraída y pasada a reproducción');
ok(st.playback.fuente === 'youtube', 'fuente clasificada como youtube');
ok(typeof st.playback.title === 'string' && st.playback.title.length > 0, 'título real obtenido por oEmbed');
ok(typeof st.playback.thumbnail === 'string', 'miniatura disponible para la cola');

// 5. B (sin permisos) no debe poder pausar
send(B, { type: 'playback', action: 'pause', time: 0 });
const err = await esperar(B, 'error');
ok(/controla/.test(err.message), 'miembro sin permisos no puede pausar');

// 6. anfitriona pausa
const e2 = estado(A);
send(A, { type: 'playback', action: 'pause', time: 12.5 });
st = await e2;
ok(st.playback.playing === false && Math.abs(st.playback.position - 12.5) < 0.5, 'anfitriona pausa en 12.5 s');

// 7. el anfitrión da permiso a B
const e3 = estado(A);
send(A, { type: 'role.set', userId: joinedB.userId, role: 'controller' });
st = await e3;
ok(st.users.find((u) => u.id === joinedB.userId).role === 'controller', 'rol controller asignado');

// 8. B ahora sí controla
const e4 = estado(A);
send(B, { type: 'playback', action: 'play', time: 20 });
st = await e4;
ok(st.playback.playing === true && Math.abs(st.playback.position - 20) < 1, 'controller reanuda en 20 s');

// 9. política "everyone"
const e5 = estado(A);
send(A, { type: 'policy', value: 'everyone' });
st = await e5;
ok(st.controlPolicy === 'everyone', 'política cambiada a todos');

// 10. cola siguiente
send(B, { type: 'queue.add', videoId: 'kJQP7kiw5Fk' });
await estado(A);
const e6 = estado(A);
send(A, { type: 'queue.next' });
st = await e6;
ok(st.playback.ref === 'kJQP7kiw5Fk', 'queue.next pasa al segundo vídeo');

// 11. voto de salto
send(B, { type: 'skip.vote' });
st = await estado(A);
ok(st.playback && st.playback.skipVotes !== undefined, 'skip.vote procesado sin error');

// 12. código inválido
const C = cliente();
await abrir(C);
send(C, { type: 'join', code: 'ZZZZZZ', name: 'Zoe' });
const errC = await esperar(C, 'error');
ok(errC.fatal === true, 'código inexistente devuelve error fatal');
C.close();

// 13. salida de B
const e7 = estado(A);
B.close();
st = await e7;
ok(st.users.length === 1, 'al salir B queda 1 usuario');

// 14. enlace inválido
send(A, { type: 'queue.add', videoId: 'no-es-un-video' });
const errD = await esperar(A, 'error');
ok(/enlace/.test(errD.message), 'entrada inválida rechazada con mensaje claro');

/* ------------------------------- plugins ------------------------------- */

// 15. solo el anfitrión activa plugins
send(A, { type: 'plugin.toggle', id: 'notas', on: false });
st = await estado(A);
ok(st.plugins.activos.notas === false, 'anfitrión desactiva el plugin de notas');
send(A, { type: 'notes.set', texto: 'esto no debe guardarse' });
const errNotas = await esperar(A, 'error');
ok(/desactivado/.test(errNotas.message), 'plugin desactivado rechaza sus mensajes');
send(A, { type: 'plugin.toggle', id: 'notas', on: true });
await estado(A);

// 16. encuesta: creación, voto y recuento
send(A, { type: 'poll.create', pregunta: '¿Pizza o tacos?', opciones: ['Pizza', 'Tacos'] });
st = await estado(A);
ok(st.plugins.estado.encuestas.activa === true, 'encuesta creada y visible para todos');
const encId = st.plugins.estado.encuestas.id;
send(A, { type: 'poll.vote', index: 1 });
const miVoto = await esperar(A, 'plugin');
ok(miVoto.accion === 'miVoto' && miVoto.index === 1 && miVoto.encuestaId === encId, 'miVoto devuelto solo al votante');
st = await estado(A);
ok(st.plugins.estado.encuestas.total === 1 && st.plugins.estado.encuestas.opciones[1].votos === 1, 'recuento de votos correcto');
ok(!('votos' in st.plugins.estado.encuestas) === true, 'el estado compartido no filtra quién votó qué');

// 17. segunda encuesta mientras hay una activa
send(A, { type: 'poll.create', pregunta: 'Otra', opciones: ['Sí', 'No'] });
const errEnc = await esperar(A, 'error');
ok(/activa/.test(errEnc.message), 'no se permiten dos encuestas a la vez');

// 18. cierre
send(A, { type: 'poll.close' });
st = await estado(A);
ok(st.plugins.estado.encuestas.cerrada === true, 'encuesta cerrada por su creadora');

// 19. notas
send(A, { type: 'notes.set', texto: 'dirección: calle Falsa 123' });
st = await estado(A);
ok(st.plugins.estado.notas.texto === 'dirección: calle Falsa 123', 'notas compartidas guardadas');

// 20. reacción (evento efímero, no estado)
const reac = esperar(A, 'reaccion');
send(A, { type: 'reaction', emoji: '🔥' });
const r = await reac;
ok(r.emoji === '🔥' && r.name === 'Ana', 'reacción retransmitida a los demás');

// 21. emoji no permitido se ignora sin romper (no emite broadcast)
send(A, { type: 'reaction', emoji: '<script>' });
const e21 = estado(A);
send(A, { type: 'chat', text: 'sigo aquí' });
st = await e21;
ok(st.plugins.activos.reacciones === true && st.chat.at(-1).text === 'sigo aquí', 'emoji inválido ignorado, la sala sigue viva');

// 22. voz: A entra al canal de voz
const e22 = estado(A);
send(A, { type: 'voz.join' });
st = await e22;
const vozA = st.plugins.estado.voz.participantes;
ok(vozA.length === 1 && vozA[0].id === joined.userId, 'A entra al canal de voz y aparece en el estado');
ok(vozA[0].silenciado === false, 'el que entra empieza con el micro abierto');

// 22b. un tercero se une (B se cerró en la prueba 13)
const V = cliente();
await abrir(V);
send(V, { type: 'join', code: joined.code, name: 'Vera' });
const joinedV = await esperar(V, 'joined');
await estado(A); // el state de su entrada, para no dejarlo pendiente
drenar(A);

// 23. V entra al canal: A recibe la lista de participantes
drenar(A);
const listaA = esperar(A, 'voz.lista');
const e23 = estado(A);
send(V, { type: 'voz.join' });
const la = await listaA;
ok(la.nuevo === joinedV.userId && la.participantes.length === 2, 'A recibe la lista con el nuevo (Vera)');
st = await e23;
ok(st.plugins.estado.voz.participantes.length === 2, 'el estado compartido lista a los dos en voz');

// 24. silenciar
drenar(A);
const e24 = estado(A);
send(A, { type: 'voz.mute', silenciado: true });
st = await e24;
ok(st.plugins.estado.voz.participantes.find((p) => p.id === joined.userId).silenciado === true, 'A se silencia y los demás lo ven');

// 25. señalización WebRTC reenviada solo al destinatario
const senV = esperar(V, 'voz.senales');
send(A, { type: 'voz.senales', para: joinedV.userId, sdp: { type: 'offer', sdp: 'v=0...' } });
const sV = await senV;
ok(sV.de === joined.userId && sV.sdp.type === 'offer', 'la oferta de A llega a Vera con su identificador');
const senA = esperar(A, 'voz.senales');
send(V, { type: 'voz.senales', para: joined.userId, ice: { candidate: 'cand', sdpMid: '0' } });
const sA = await senA;
ok(sA.de === joinedV.userId && sA.ice.candidate === 'cand', 'el candidato ICE de Vera llega a A');

// 26. "está hablando" es un evento efímero
const hablaA = esperar(A, 'voz.habla');
send(V, { type: 'voz.habla', hablando: true });
const h = await hablaA;
ok(h.userId === joinedV.userId && h.hablando === true, 'el aviso de "hablando" se retransmite');

// 27. salir del canal
drenar(A);
const e27 = estado(A);
send(A, { type: 'voz.leave' });
st = await e27;
ok(st.plugins.estado.voz.participantes.length === 1, 'al salir del canal desaparece de la lista');

// 28. alguien que no está en el canal no puede señalizar
drenar(A);
send(V, { type: 'voz.leave' });
await new Promise((r) => setTimeout(r, 600));
drenar(A);
send(V, { type: 'voz.senales', para: joined.userId, sdp: { type: 'offer' } });
send(A, { type: 'chat', text: 'tranquilo' });
st = await esperarChat(A, 'tranquilo');
ok(st.chat.at(-1).text === 'tranquilo', 'señalar fuera del canal se ignora sin romper nada');
const sawSenales = buf(A).some((x) => { try { return JSON.parse(x).type === 'voz.senales'; } catch { return false; } });
ok(!sawSenales, 'el mensaje de señalización de quien está fuera del canal no se reenvía');

// 29. al desconectar se sale del canal
drenar(A);
const e29 = estado(A);
send(V, { type: 'voz.join' });
await e29;
drenar(A);
const e30 = estado(A);
V.close();
st = await e30;
ok(st.plugins.estado.voz.participantes.every((p) => p.id !== joinedV.userId), 'al cerrar la pestaña se sale del canal de voz');

// 30. el anfitrión puede desactivar el plugin de voz
drenar(A);
const e31 = estado(A);
send(A, { type: 'plugin.toggle', id: 'voz', on: false });
st = await e31;
ok(st.plugins.activos.voz === false, 'anfitrión desactiva el plugin de voz');
send(A, { type: 'voz.join' });
const errVoz = await esperar(A, 'error');
ok(/desactivado/.test(errVoz.message), 'con la voz desactivada se rechazan sus mensajes');

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
A.close();
setTimeout(() => process.exit(fallos ? 1 : 0), 300);
