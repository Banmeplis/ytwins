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

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
setTimeout(() => process.exit(fallos ? 1 : 0), 100);
