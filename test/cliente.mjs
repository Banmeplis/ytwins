/* Comprobación de los scripts del cliente.
 *
 * Los scripts del navegador (sin módulos) comparten el ámbito global: si dos
 * de ellos, o el mismo dos veces, declaran el mismo `const`, la página entera
 * deja de arrancar con "Identifier 'x' has already been declared" y no se ve
 * nada. Este test lo detecta antes de que llegue al navegador.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PUBLIC = path.join(process.cwd(), 'public');
let fallos = 0;
const ok = (cond, nombre) => {
  console.log(`${cond ? '  PASS' : '✗ FAIL'}  ${nombre}`);
  if (!cond) fallos++;
};

// quitamos comentarios y cadenas para no contar lo que está dentro
const limpiar = (txt) =>
  txt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

/** Deja en blanco el cuerpo de una IIFE: lo de ahí dentro no es global. */
function fueraDeIIFE(codigo) {
  const inicio = codigo.indexOf('(function (');
  if (inicio < 0) return codigo;
  let i = codigo.indexOf('{', inicio);
  if (i < 0) return codigo;
  let nivel = 0;
  let fin = i;
  for (; fin < codigo.length; fin++) {
    const c = codigo[fin];
    if (c === '{') nivel++;
    else if (c === '}') { nivel--; if (nivel === 0) break; }
  }
  return codigo.slice(0, i) + ' '.repeat(fin - i) + codigo.slice(fin);
}

const DECL = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

const ficheros = (await readdir(PUBLIC)).filter((f) => f.endsWith('.js'));
ok(ficheros.length >= 3, `hay ${ficheros.length} scripts en public/`);

const global_ = new Map(); // nombre -> [ficheros]
for (const f of ficheros) {
  const codigo = fueraDeIIFE(limpiar(await readFile(path.join(PUBLIC, f), 'utf8')));
  const vistoAqui = new Set();
  for (const m of codigo.matchAll(DECL)) {
    const nombre = m[1];
    if (vistoAqui.has(nombre)) ok(false, `${f}: "${nombre}" se declara dos veces en el mismo archivo`);
    vistoAqui.add(nombre);
    if (!global_.has(nombre)) global_.set(nombre, []);
    global_.get(nombre).push(f);
  }
}

// los nombres globales reservados de la API del navegador no se tocan
const RESERVADOS = new Set(['name', 'status', 'length', 'event', 'origin', 'top', 'self', 'parent']);

const colisiones = [...global_.entries()].filter(([n, fs]) => fs.length > 1 && !RESERVADOS.has(n));
ok(colisiones.length === 0, 'ningún script del cliente declara el mismo nombre global que otro');
for (const [n, fs] of colisiones) console.log(`       "${n}" aparece en: ${fs.join(', ')}`);

// y que app.js llame a la voz sin romperse si el plugin no cargó
const app = await readFile(path.join(PUBLIC, 'app.js'), 'utf8');
ok(/YTwinsVoz\?\./.test(app), 'app.js protege las llamadas a la voz (YTwinsVoz?.)');

// ningún helper de voz declarado dos veces en app.js
const codigoApp = limpiar(app);
for (const nombre of ['vozPluginActivo', 'hablandoIds', 'pintarBotonVoz', 'atenuarVideo', 'marcarHablando']) {
  const veces = (codigoApp.match(new RegExp(`^(?:const|let|function)\\s+${nombre}\\b`, 'gm')) || []).length;
  ok(veces === 1, `app.js declara "${nombre}" exactamente una vez (${veces})`);
}

// el IIFE de voz.js no debe filtrar nombres al global
const vozJs = await readFile(path.join(PUBLIC, 'voz.js'), 'utf8');
ok(/\(function \(\)/.test(vozJs), 'voz.js va dentro de una IIFE (no pisa el global)');
ok((vozJs.match(/window\.YTwinsVoz\s*=/g) || []).length === 1, 'voz.js expone un único punto de entrada');
ok(/nivel: \(\) => voz\.nivel/.test(vozJs), 'voz.js expone el nivel para el medidor');

// el audio remoto tiene que estar en el DOM y avisar si el navegador lo bloquea:
// si no, el grupo se queda en silencio sin enterarse (bug real)
// y app.js debe registrar el manejador del diagnóstico (si app.js peta antes,
// nada más del final del arranque se registra: es lo que pasó con miId)
// la voz nueva viaja POR EL SERVIDOR (el mismo WebSocket de la sala): sin
// WebRTC, sin TURN, sin autoplay de tráfico de red. Lo que no puede faltar:
// captura con AudioWorklet, envío por el WS, reintento tras un clic, y el
// vigilante del canal de captura (si app.js petara antes de registrarse,
// nada del final del arranque funcionaría: es lo que pasó con miId)
ok(/reintentarAudio/.test(vozJs) && /reintentarAudio/.test(app), 'app.js reintenta el audio tras un clic');
ok(/iniciarVoz\(\{[\s\S]{0,120}miId: yoId/.test(app), 'iniciarVoz recibe miId: yoId (el identificador existe en app.js)');
ok(!/\biniciarVoz\(\{[^}]*\bmiId\b(?!:)/.test(app), 'nadie pasa miId suelto (no existe en app.js)');
ok(/#btn-diagnostico/.test(app) && /diagnostico/.test(vozJs), 'el diagnóstico del audio está cableado');
ok(!/RTCPeerConnection/.test(vozJs), 'la voz ya no usa WebRTC (el servidor reparte el audio)');
ok(!/cargarTurn/.test(vozJs), 'ya no hacen falta servidores TURN');

ok(/AudioWorkletNode/.test(vozJs) && /capturador/.test(vozJs), 'el micro se captura con un AudioWorklet');
ok(/type: 'voz\.audio'/.test(vozJs), 'el audio sale por el WebSocket de la sala');
ok(/cola\.length > 30/.test(vozJs), 'la recepción controla el estancamiento de la cola');
ok(/function contextoAudio\(\)/.test(vozJs), 'hay un único contexto de audio compartido');
ok(/ctx\.destination/.test(vozJs), 'el audio recibido se conecta a la salida del contexto');
ok(/state !== 'running'\) voz\.ctx\.resume\(\)/.test(vozJs), 'el contexto se desbloquea con cualquier clic');
ok(/vigilarSalida/.test(vozJs), 'hay vigilante del canal de captura (micro que se duerme)');
ok(/'sin-sonido'/.test(vozJs), 'se avisa cuando el navegador no puede sonar');

// y el servidor reparte el audio de la voz al canal
const pluginsJs = await readFile(path.join(PUBLIC, '..', 'server', 'plugins.js'), 'utf8');
ok(/type === 'voz\.audio'/.test(pluginsJs), 'el servidor reenvía el audio a los del canal');
ok(!/voz\.senales/.test(pluginsJs), 'el servidor ya no hace de señalización WebRTC');

// la cola tiene que avanzar sola: si el final solo lo avisa quien controla,
// con esa pestaña en segundo plano el grupo se queda en silencio
ok(/type: 'playback\.ended'/.test(app), 'el cliente avisa de que el vídeo acabó');
ok(!/terminar:[\s\S]{0,160}queue\.next/.test(app), 'al acabar no se mandan dos mensajes (se saltaría una canción)');
ok(/playback\.duracion/.test(app), 'el cliente informa de la duración real del vídeo');
ok(/duracionSegundos/.test(app), 'la duración del buscador se convierte a segundos');
const serverJs = await readFile(path.join(PUBLIC, '..', 'server', 'index.js'), 'utf8');
const indexHtml = await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
ok(/case 'playback\.ended'/.test(serverJs), 'el servidor acepta el aviso de fin de vídeo');
ok(/case 'playback\.duracion'/.test(serverJs), 'el servidor guarda la duración real');
ok(/posicionActual\(room\) >= pb\.duration|posicionActual\(room\) < pb\.duration/.test(serverJs), 'el servidor comprueba el final del vídeo por su cuenta');

// el micro solo debe vivir dentro de la sala: si sales, se cae la conexión
// o el anfitrión desactiva el plugin, el micrófono se apaga de verdad
ok(/pararMicro/.test(vozJs), 'voz.js tiene una parada explícita del micro');
ok(/pagehide/.test(vozJs) && /beforeunload/.test(vozJs), 'el micro se apaga al cerrar la pestaña');
ok(/t\.stop\(\)/.test(vozJs), 'las pistas del micro se detienen (el navegador deja de grabar)');
ok(/salirVoz\(\)/.test(app), 'al cerrar la sala se apaga el micro');
ok(/ws\.onclose[\s\S]{0,600}salirVoz\(\)/.test(app), 'si se cae la conexión, el micro se apaga');
ok(/!vozPluginActivo\(\)[\s\S]{0,400}salirVoz\(\)/.test(app), 'si el anfitrión desactiva la voz, el micro se apaga');

// las cuatro salas públicas: se entra con el nombre, sin código, y las
// privadas se siguen creando con su código de 6 letras
ok(/lista-publicas/.test(indexHtml) && /pub-sala/.test(app), 'el lobby tiene las tarjetas de salas públicas');
ok(/entrarPublica/.test(app) && /api\/salas\/publicas/.test(app), 'el cliente entra en las salas públicas con un clic');
ok(/SALA_PUBLICAS|publicas/.test(serverJs) && /api\/salas\/publicas/.test(serverJs), 'el servidor expone las salas públicas y su API');
ok(/Crear una sala privada/.test(indexHtml), 'el lobby ofrece crear una sala privada');

// el versionado automático de los archivos del cliente: sin esto el
// navegador se queda con un JS viejo y aparecen avisos fantasma (como el
// "no me deja reproducir" cuando el código ya estaba arreglado)
ok(/huellaCliente/.test(serverJs) && /\?v=/.test(serverJs), 'el servidor versiona el JS y el CSS del cliente');

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
setTimeout(() => process.exit(fallos ? 1 : 0), 100);
