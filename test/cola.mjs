/* Prueba de la cola: al terminar un vídeo, la sala tiene que pasar sola al
 * siguiente. Antes solo avanzaba quien controlaba y solo si su navegador
 * disparaba el evento "ended" (una pestaña en segundo plano no lo dispara):
 * el grupo se quedaba en silencio con la cola parada. */
import WebSocket from 'ws';

const URL = process.env.URL_SALA || 'ws://localhost:3000';
let fallos = 0;
const ok = (cond, texto) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + texto);
  if (!cond) fallos++;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function cliente() {
  return new Promise((res) => {
    const ws = new WebSocket(URL);
    const c = { ws, id: null, codigo: null, estados: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'create', name: 'Sala de cola', userName: 'Anfitrión' })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'joined') { c.id = m.userId; c.codigo = m.code; res(c); }
      if (m.type === 'state') c.estados.push(m);
    });
    setTimeout(() => res(c), 4000);
  });
}

const esperaEstado = (c, ms = 6000) =>
  new Promise((res) => {
    const t0 = Date.now();
    const mirar = () => {
      const ultimo = c.estados[c.estados.length - 1];
      if (ultimo && Date.now() - t0 > 250) return res(ultimo);
      if (Date.now() - t0 > ms) return res(ultimo || null);
      setTimeout(mirar, 150);
    };
    mirar();
  });

const A = await cliente();
ok(!!A.id, 'sala creada');
if (!A.id) process.exit(1);

// primer vídeo (dura 3 s) y segundo en la cola
A.ws.send(JSON.stringify({ type: 'queue.add', videoId: 'kJQP7kiw5Fk', title: 'Primero', duration: 3 }));
await espera(700);
A.ws.send(JSON.stringify({ type: 'queue.add', videoId: '9bZkp7q19f0', title: 'Segundo', duration: 300 }));
await espera(700);
let st = await esperaEstado(A);
ok(st?.playback?.title === 'Primero', 'el primer vídeo está en marcha (' + (st?.playback?.title || '?') + ')');
ok(st?.playback?.duration === 3, 'el servidor guarda la duración que le pasó el cliente');

// el servidor avanza solo al acabarse (sin que nadie pulse "siguiente")
st = await new Promise((res) => {
  const t0 = Date.now();
  const mirar = () => {
    const u = A.estados[A.estados.length - 1];
    if (u && u.playback && u.playback.title === 'Segundo') return res(u);
    if (Date.now() - t0 > 12000) return res(u || null);
    setTimeout(mirar, 200);
  };
  mirar();
});
ok(st?.playback?.title === 'Segundo', 'la cola avanza sola al terminar el vídeo (vía título: ' + (st?.playback?.title || '?') + ')');
ok(st?.playback?.position === 0, 'el vídeo nuevo empieza desde el principio');

// cualquiera puede avisar de que se acabó: el servidor lo comprueba
A.estados.length = 0;
A.ws.send(JSON.stringify({ type: 'playback', action: 'seek', time: 299 }));
await espera(400);
A.ws.send(JSON.stringify({ type: 'playback.ended' }));
st = await new Promise((res) => {
  const t0 = Date.now();
  const mirar = () => {
    const u = A.estados[A.estados.length - 1];
    if (u && u.playback && u.playback.playing === false) return res(u);
    if (Date.now() - t0 > 8000) return res(u || null);
    setTimeout(mirar, 200);
  };
  mirar();
});
ok(st?.playback?.playing === false, 'al avisar del final y no quedar cola, la reproducción se detiene');

A.ws.close();
console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
process.exit(fallos ? 1 : 0);
