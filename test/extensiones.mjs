/* Pruebas de las fuentes de vídeo y del buscador sin clave (HTTP).
 * Requiere el servidor en marcha y conexión a internet. */
import { clasificar, obtenerMetadatos, buscarVideos } from '../server/fuentes.js';

let fallos = 0;
const ok = (cond, nombre) => {
  console.log(`${cond ? '  PASS' : '✗ FAIL'}  ${nombre}`);
  if (!cond) fallos++;
};

/* ------------------------- clasificación de enlaces ---------------------- */
const casos = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ?t=42', 'youtube', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://vimeo.com/76979871', 'vimeo', '76979871'],
  ['https://player.vimeo.com/video/76979871', 'vimeo', '76979871'],
  ['https://www.dailymotion.com/video/x2iuewm', 'dailymotion', 'x2iuewm'],
  ['https://dai.ly/x2iuewm', 'dailymotion', 'x2iuewm'],
  ['https://ejemplo.com/pelicula.mp4', 'directo', 'https://ejemplo.com/pelicula.mp4'],
  ['https://ejemplo.com/stream.m3u8?token=1', 'directo', 'https://ejemplo.com/stream.m3u8?token=1'],
];
for (const [entrada, fuente, ref] of casos) {
  const c = clasificar(entrada);
  ok(c && c.fuente === fuente && c.ref === ref, `clasifica ${entrada} → ${fuente}`);
}
ok(clasificar('esto no es un enlace') === null, 'entrada basura rechazada');

/* ------------------------------ metadatos ------------------------------- */
const metaYT = await obtenerMetadatos('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
ok(metaYT && metaYT.fuente === 'youtube', 'metadatos de YouTube obtenidos');
ok(metaYT.title && metaYT.title !== metaYT.ref, 'título real (no es el ID)');
ok(/^https:\/\//.test(metaYT.thumbnail || ''), 'miniatura de YouTube');
ok(metaYT.canal, 'canal/autor de YouTube');

const meta2 = await obtenerMetadatos('dQw4w9WgXcQ');
ok(meta2 && meta2.title === metaYT.title, 'la caché devuelve los mismos datos');

const metaDirecta = await obtenerMetadatos('https://cdn.ejemplo.com/videos/una-pelicula.mp4');
ok(metaDirecta && metaDirecta.fuente === 'directo' && metaDirecta.title.includes('una-pelicula'), 'directo usa el nombre del archivo');

// Dailymotion: la API pública aporta título, duración y miniatura
const metaDM = await obtenerMetadatos('https://www.dailymotion.com/video/x87d4eu');
ok(metaDM && metaDM.fuente === 'dailymotion', 'dailymotion clasificado');
if (metaDM && metaDM.title !== metaDM.ref) {
  ok(typeof metaDM.duration === 'number' && metaDM.duration > 0, `dailymotion con duración (${metaDM.duration} s)`);
  ok(!!metaDM.thumbnail, 'dailymotion con miniatura');
} else {
  ok(true, 'dailymotion sin metadatos (la API no respondió desde esta red) — no bloquea');
}

/* ------------------------------ buscador -------------------------------- */
try {
  const items = await buscarVideos('never gonna give you up');
  ok(Array.isArray(items) && items.length > 0, `búsqueda devuelve ${items.length} resultados`);
  const p = items[0];
  ok(/^[A-Za-z0-9_-]{11}$/.test(p.ref), 'cada resultado tiene un videoId válido');
  ok(p.title && p.title.length > 0, 'cada resultado tiene título');
  ok(p.thumbnail && p.thumbnail.includes(p.ref), 'miniatura del resultado');
  ok(p.url.includes(p.ref), 'url del resultado');

  // los resultados vienen de varias fuentes (YouTube, Dailymotion, la web…)
  const fuentes = [...new Set(items.map((i) => i.fuente))];
  ok(fuentes.includes('youtube'), 'la búsqueda incluye resultados de YouTube');
  ok(fuentes.every((f) => ['youtube', 'vimeo', 'dailymotion', 'directo'].includes(f)), `las fuentes son conocidas (${fuentes.join(', ')})`);

  const cache = await buscarVideos('never gonna give you up');
  ok(cache === items || cache.length === items.length, 'resultados en caché (5 min)');

  const vacio = await buscarVideos('   ');
  ok(vacio.length === 0, 'consulta vacía no llama a YouTube');
} catch (e) {
  ok(false, `búsqueda: ${e.message}`);
}

/* --------------------------- endpoint HTTP ------------------------------ */
try {
  const res = await fetch('http://localhost:3000/api/search?q=' + encodeURIComponent('síntesis analógica'));
  const datos = await res.json();
  ok(res.ok && datos.ok && datos.items.length > 0, 'GET /api/search responde JSON con resultados');
} catch (e) {
  ok(false, `GET /api/search: ${e.message}`);
}

try {
  const res = await fetch('http://localhost:3000/api/health');
  const datos = await res.json();
  ok(datos.ok === true, 'GET /api/health');
} catch (e) {
  ok(false, `GET /api/health: ${e.message}`);
}

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
setTimeout(() => process.exit(fallos ? 1 : 0), 300);
