/* Pruebas del plugin de IA (sin clave: todo debe fallar con elegancia). */
import { disponible, preguntar, contextoChat, limpiar, SIN_CONFIGURAR } from '../server/ia.js';

let fallos = 0;
const ok = (cond, nombre) => {
  console.log(`${cond ? '  PASS' : '✗ FAIL'}  ${nombre}`);
  if (!cond) fallos++;
};

/* ------------------------------ apagada -------------------------------- */
const conf = disponible();
ok(conf.ok === false, 'sin OPENAI_API_KEY la IA queda apagada');
ok(conf.modelo === null, 'y no anuncia modelo');
ok(SIN_CONFIGURAR.length > 10, 'el aviso para la interfaz explica qué falta');

const r = await preguntar([{ role: 'user', content: 'hola' }]);
ok(r === null, 'preguntar() devuelve null (nunca revienta)');

/* ------------------------------ utilidades ----------------------------- */
const chat = [
  { userId: 'u1', name: 'Ana', text: 'hola' },
  { userId: 'u2', name: 'Beto', text: 'qué tal' },
  { userId: '__sistema__', name: 'sistema', text: 'Beto entró en la sala' },
];
const ctx = contextoChat(chat);
ok(ctx.length === 3, 'el contexto incluye todos los mensajes');
ok(ctx[0].content === 'Ana: hola', 'el contexto nombra a quien habla');
ok(ctx[2].role === 'system', 'los avisos del sistema van como system');
ok(ctx.every((m) => m.role && m.content), 'todos los mensajes tienen rol y contenido');

const solo = contextoChat(chat, 2);
ok(solo.length === 2 && solo[0].content === 'Beto: qué tal', 'el límite de mensajes se respeta (se queda con los últimos)');

ok(limpiar('  "Hola"  ') === 'Hola', 'limpiar quita comillas y espacios');
ok(limpiar('«Hola»') === 'Hola', 'limpiar quita comillas angulares');
ok(limpiar('```\ntexto\n```') === 'texto', 'limpiar quita bloques de código');
ok(limpiar('a\n\n\nb') === 'a\nb', 'limpiar colapsa líneas vacías');
ok(limpiar(null) === '', 'limpiar(null) no rompe');

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
setTimeout(() => process.exit(fallos ? 1 : 0), 100);
