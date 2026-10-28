/**
 * Fuentes de vídeo y metadatos, sin claves de API.
 *  - youtube / vimeo / dailymotion: se resuelve el ID y se piden datos por oEmbed
 *  - directo: .mp4/.webm/.ogg/.m3u8 que reproduce el propio navegador
 *  - búsqueda: se consulta la página de resultados de YouTube (y la API pública
 *    de Dailymotion + búsquedas web tipo DuckDuckGo) desde el servidor (evita el
 *    bloqueo CORS del navegador) y se extraen id, título y duración.
 *    Así un mismo buscador sirve para "cualquier lugar", no solo YouTube.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTL_META = 30 * 60_000;
const TTL_BUSQUEDA = 5 * 60_000;

const cacheMeta = new Map(); // url -> { datos, expira }
const cacheBusqueda = new Map(); // consulta -> { items, expira }

/** Clasifica lo que pegue el usuario en una fuente concreta. */
export function clasificar(entrada) {
  const s = String(entrada || '').trim();
  if (!s) return null;

  const yt = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/) || s.match(/[?&]v=([\w-]{11})/);
  if (yt) return { fuente: 'youtube', ref: yt[1], url: `https://www.youtube.com/watch?v=${yt[1]}` };

  const vimeo = s.match(/vimeo\.com\/(?:video\/)?(\d{6,12})/);
  if (vimeo) return { fuente: 'vimeo', ref: vimeo[1], url: `https://vimeo.com/${vimeo[1]}` };

  const dm = s.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-z0-9]{5,12})/i);
  if (dm) return { fuente: 'dailymotion', ref: dm[1], url: `https://www.dailymotion.com/video/${dm[1]}` };

  if (/\.(mp4|webm|ogg|ogv|m3u8)(\?.*)?$/i.test(s)) return { fuente: 'directo', ref: s, url: s };

  if (/^[\w-]{11}$/.test(s)) return { fuente: 'youtube', ref: s, url: `https://www.youtube.com/watch?v=${s}` };

  return null;
}

async function json(url, ms = 5000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Devuelve { fuente, ref, url, title, canal, thumbnail, duration } tolerando fallos de red. */
export async function obtenerMetadatos(entrada) {
  const base = clasificar(entrada);
  if (!base) return null;

  const guardado = cacheMeta.get(base.url);
  if (guardado && guardado.expira > Date.now()) return guardado.datos;

  let extra = { title: base.fuente === 'directo' ? nombreDesdeUrl(base.url) : base.ref, canal: null, thumbnail: null, duration: null };
  try {
    if (base.fuente === 'youtube') {
      const d = await json(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(base.url)}`);
      extra = { title: d.title || extra.title, canal: d.author_name || null, thumbnail: d.thumbnail_url || `https://i.ytimg.com/vi/${base.ref}/mqdefault.jpg`, duration: null };
    } else if (base.fuente === 'vimeo') {
      const d = await json(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(base.url)}`);
      extra = { title: d.title || extra.title, canal: d.author_name || null, thumbnail: d.thumbnail_url || null, duration: typeof d.duration === 'number' ? d.duration : null };
    } else if (base.fuente === 'dailymotion') {
      // la API pública da título, duración y miniatura sin clave
      const d = await json(`https://api.dailymotion.com/video/${base.ref}?fields=title,duration,thumbnail_url,owner_screenname`);
      extra = {
        title: d.title || extra.title,
        canal: d.owner_screenname || null,
        thumbnail: d.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${base.ref}`,
        duration: typeof d.duration === 'number' ? d.duration : null,
      };
    } else {
      extra.thumbnail = null;
    }
  } catch {
    /* sin conexión: se queda con los datos mínimos */
  }

  const datos = { ...base, ...extra };
  cacheMeta.set(base.url, { datos, expira: Date.now() + TTL_META });
  if (cacheMeta.size > 500) cacheMeta.delete(cacheMeta.keys().next().value);
  return datos;
}

const nombreDesdeUrl = (u) => {
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || u);
  } catch {
    return u;
  }
};

/** Busca en YouTube (la fuente principal) y devuelve resultados listos para la cola. */
async function buscarYoutube(texto) {
  const q = String(texto || '').trim().slice(0, 80);
  if (!q) return [];

  const enCache = cacheBusqueda.get(q);
  if (enCache && enCache.expira > Date.now()) return enCache.items;

  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=es&gl=ES`, {
    headers: { 'user-agent': UA, 'accept-language': 'es,es;q=0.9' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`YouTube respondió ${res.status}`);
  const html = await res.text();

  const m =
    html.match(/ytInitialData"\]\s*=\s*(\{.+?\})\s*;\s*<\/script>/s) ||
    html.match(/var ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s);
  if (!m) throw new Error('No pude leer los resultados de YouTube (puede estar bloqueando peticiones automáticas).');

  const datos = JSON.parse(m[1]);
  const items = [];
  const visto = new Set();

  const extraer = (v, tipo) => {
    if (!v?.videoId || visto.has(v.videoId)) return;
    visto.add(v.videoId);
    const enlace = `https://www.youtube.com/watch?v=${v.videoId}`;
    items.push({
      fuente: 'youtube',
      ref: v.videoId,
      url: enlace,
      title: v.title?.runs?.[0]?.text || v.title?.simpleText || v.videoId,
      canal: v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || null,
      duration: v.lengthText?.simpleText || null,
      views: v.viewCountText?.simpleText || null,
      enVivo: tipo === 'reel' || !v.lengthText,
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    });
  };

  (function caminar(nodo, prof) {
    if (!nodo || typeof nodo !== 'object' || prof > 40 || items.length > 8) return; // tope por fuente: deja sitio a las demás
    if (Array.isArray(nodo)) {
      for (const hijo of nodo) caminar(hijo, prof + 1);
      return;
    }
    if (nodo.videoRenderer) extraer(nodo.videoRenderer, 'video');
    else if (nodo.compactVideoRenderer) extraer(nodo.compactVideoRenderer, 'compact');
    else if (nodo.reelItemRenderer) extraer(nodo.reelItemRenderer, 'reel');
    else if (nodo.gridVideoRenderer) extraer(nodo.gridVideoRenderer, 'grid');
    for (const clave of Object.keys(nodo)) caminar(nodo[clave], prof + 1);
  })(datos, 0);

  cacheBusqueda.set(q, { items, expira: Date.now() + TTL_BUSQUEDA });
  if (cacheBusqueda.size > 100) cacheBusqueda.delete(cacheBusqueda.keys().next().value);
  return items;
}

/** Busca en Dailymotion con su API pública (no hace falta clave de acceso). */
async function buscarDailymotion(texto) {
  const q = String(texto || '').trim().slice(0, 80);
  const res = await fetch(`https://api.dailymotion.com/videos?search_terms=${encodeURIComponent(q)}&fields=title,duration,thumbnail_url,owner_screenname&limit=12`, {
    headers: { 'user-agent': UA, 'accept-language': 'es' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Dailymotion respondió ${res.status}`);
  const d = await res.json();
  const videos = d?.videos || d?.response?.videos || d?.data || [];
  if (!Array.isArray(videos) || !videos.length) return [];
  const items = [];
  for (const v of videos.slice(0, 12)) {
    const ref = String(v?.id || '');
    if (!ref) continue;
    const dur = Number(v?.duration);
    items.push({
      fuente: 'dailymotion',
      ref,
      url: `https://www.dailymotion.com/video/${ref}`,
      title: String(v?.title || '').trim() || 'Vídeo de Dailymotion',
      canal: v?.owner_screenname || v?.owner?.screen_name || null,
      thumbnail: v?.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${ref}`,
      duration: isFinite(dur) && dur > 0 ? Math.round(dur) : null,
      views: v?.view_count != null ? String(v.view_count) : null,
    });
  }
  return items;
}

/** Busca en la web (DuckDuckGo) para encontrar videos que no están en YouTube. */
async function buscarEnRed(texto) {
  const q = String(texto || '').trim().slice(0, 80);
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q + ' video')}`, {
    headers: { 'user-agent': UA, 'accept-language': 'es' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`Búsqueda web respondió ${res.status}`);
  const html = await res.text();
  const bloques = html.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
  const items = [];
  const vistos = new Set();
  for (const b of bloques) {
    const href = (b.match(/href="([^"]*)"/) || [])[1] || '';
    const uddg = href.match(/uddg=([^&"]+)/);
    if (!uddg) continue;
    let url = '';
    try { url = decodeURIComponent(uddg[1]); } catch { continue; }
    const base = clasificar(url);
    if (!base) continue;
    const k = `${base.fuente}:${base.ref}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    const titulo = (b.match(/>([\s\S]*?)<\/a>/) || [])[1] || '';
    items.push({
      fuente: base.fuente,
      ref: base.ref,
      url,
      title: String(titulo).replace(/<[^>]*>/g, '').trim() || `Vídeo en ${base.fuente}`,
      canal: null,
      thumbnail: null,
      duration: null,
      views: null,
    });
  }
  return items;
}

/** Busca en YouTube, Dailymotion y en la web: no solo en YouTube. */
export async function buscarVideos(texto) {
  const q = String(texto || '').trim().slice(0, 80);
  if (!q) return [];

  const enCache = cacheBusqueda.get(q);
  if (enCache && enCache.expira > Date.now()) return enCache.items;

  const items = [];
  const vistas = new Set();
  const empujar = (it) => {
    if (!it?.ref) return;
    const k = `${it.fuente}:${it.ref}`;
    if (vistas.has(k)) return;
    vistas.add(k);
    items.push(it);
  };

  // 1) YouTube (buscarYoutube ya cachea sus resultados por consulta)
  try { for (const it of await buscarYoutube(texto)) empujar(it); } catch { /* cae al resto de fuentes */ }
  // 2) Dailymotion: su API pública no necesita clave de acceso
  try { for (const it of await buscarDailymotion(texto)) empujar(it); } catch { /* sin resultados de DM */ }
  // 3) la web en general: vídeos que no están en YouTube
  try { for (const it of await buscarEnRed(texto)) empujar(it); } catch { /* sin resultados web */ }

  const limpio = items.slice(0, 24);
  cacheBusqueda.set(q, { items: limpio, expira: Date.now() + TTL_BUSQUEDA });
  if (cacheBusqueda.size > 100) cacheBusqueda.delete(cacheBusqueda.keys().next().value);
  return limpio;
}
