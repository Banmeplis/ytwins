/**
 * IA opcional para YTwins.
 *
 * Habla con cualquier API compatible con OpenAI (OpenAI, Groq, Together,
 * Ollama en local...). La clave NUNCA sale del servidor: el navegador solo
 * pide funciones de la sala por WebSocket.
 *
 * Variables de entorno (todas opcionales):
 *   OPENAI_API_KEY    → sin esto, la IA queda apagada y la app funciona igual
 *   OPENAI_BASE_URL   → por defecto https://api.openai.com/v1
 *   OPENAI_MODEL      → por defecto gpt-4o-mini
 *   YR_IA_TIMEOUT_MS  → por defecto 12000
 *
 * Sin clave no se rompe nada: `disponible()` devuelve false y las funciones
 * devuelven un motivo claro en vez de un error.
 */
const CLAVE = process.env.OPENAI_API_KEY || '';
const BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODELO = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TIMEOUT = Number(process.env.YR_IA_TIMEOUT_MS || 12000);

export function disponible() {
  return { ok: Boolean(CLAVE), modelo: CLAVE ? MODELO : null };
}

/** Motivo corto y utilizable en la interfaz cuando la IA no está puesta. */
export const SIN_CONFIGURAR =
  'La IA está apagada: falta definir OPENAI_API_KEY en el servidor (Environment en Render).';

/**
 * Llama al modelo y devuelve el texto, o `null` si no se pudo.
 * @param {Array<{role:string,content:string}>} mensajes
 * @param {{maxTokens?:number, temperatura?:number}} opciones
 */
export async function preguntar(mensajes, { maxTokens = 400, temperatura = 0.7 } = {}) {
  if (!CLAVE) return null;

  const controlador = new AbortController();
  const reloj = setTimeout(() => controlador.abort(), TIMEOUT);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLAVE}` },
      body: JSON.stringify({ model: MODELO, messages, max_tokens: maxTokens, temperature: temperatura }),
      signal: controlador.signal,
    });
    if (!r.ok) {
      console.warn(`  ⚠ IA respondió ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return null;
    }
    const datos = await r.json();
    return datos?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn(`  ⚠ IA no respondió: ${e.message}`);
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

/* ------------------------------ utilidades ------------------------------ */

/** Agrupa los últimos mensajes del chat para mandarlos como contexto. */
export function contextoChat(mensajes = [], ultimo = 40) {
  return mensajes.slice(-ultimo).map((m) => ({
    role: m.userId === '__sistema__' ? 'system' : 'user',
    content: m.userId === '__sistema__' ? m.text : `${m.name}: ${m.text}`,
  }));
}

/** Limpia una respuesta del modelo: sin comillas sueltas ni líneas en blanco. */
export function limpiar(texto) {
  return String(texto || '')
    .trim()
    .replace(/^```[\s\S]*?\n|```$/g, '')
    .trim()
    .replace(/^["'«]|["'»]$/g, '')
    .replace(/\s*\n\s*\n\s*/g, '\n')
    .trim();
}
