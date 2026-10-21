/* Prueba de la voz por el servidor: el audio del micro tiene que viajar por
 * el mismo WebSocket de la sala y el servidor tiene que reenviarlo al canal.
 * (Antes esto era WebRTC: ICE, TURN y el navegador AUTOPLAY; ahora es solo
 * el WebSocket que ya usa el chat.) */
import WebSocket from 'ws';

const URL = process.env.URL_SALA || 'ws://localhost:3000';
let fallos = 0;
const ok = (cond, texto) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + texto);
  if (!cond) fallos++;
};

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function abrir() {
  return new Promise((res) => {
    const ws = new WebSocket(URL);
    const c = { ws, id: null, codigo: null, audio: [], tipos: new Set() };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'create', name: 'Sala de prueba', userName: 'Ana' })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      c.tipos.add(m.type);
      if (m.type === 'joined') {
        c.id = m.userId;
        c.codigo = m.code;
        res(c);
      }
      if (m.type === 'voz.audio') c.audio.push(m);
    });
    setTimeout(() => res(c), 4000); // por si el servidor no contesta
  });
}

const ana = await abrir();
ok(!!ana.id && !!ana.codigo, 'la sala se crea y devuelve código (' + (ana.codigo || 'sin código') + ')');
if (!ana.codigo) process.exit(1);

// Beto entra en la sala
const beto = await new Promise((res) => {
  const ws = new WebSocket(URL);
  const c = { ws, id: null, audio: [], tipos: new Set() };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: ana.codigo, name: 'Beto' })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    c.tipos.add(m.type);
    if (m.type === 'joined') { c.id = m.userId; res(c); }
    if (m.type === 'voz.audio') c.audio.push(m);
  });
  setTimeout(() => res(c), 4000);
});
ok(!!beto.id, 'el segundo usuario entra en la sala');

// los dos entran al canal de voz
ana.ws.send(JSON.stringify({ type: 'voz.join' }));
beto.ws.send(JSON.stringify({ type: 'voz.join' }));
await espera(600);
ok(ana.tipos.has('voz.lista') && beto.tipos.has('voz.lista'), 'el servidor avisa del canal de voz (voz.lista)');

// Ana "habla": manda audio en base64 (90 ms a 16 kHz mono int16)
const muestras = 16 * 1000 * 0.09;
const bytes = Buffer.alloc(muestras * 2);
for (let i = 0; i < muestras; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 9) * 9000), i * 2);
const datos = bytes.toString('base64');
for (let i = 0; i < 6; i++) {
  ana.ws.send(JSON.stringify({ type: 'voz.audio', seq: i, datos }));
  await espera(90);
}
await espera(700);

ok(beto.audio.length >= 3, 'el otro recibe el audio por el servidor (' + beto.audio.length + ' tramos)');
if (beto.audio.length) {
  const t = beto.audio[0];
  ok(t.de === ana.id, 'el audio viene del emisor correcto');
  ok(typeof t.datos === 'string' && t.datos.length > 100, 'el audio llega con contenido (' + (t.datos?.length || 0) + ' caracteres)');
  ok(beto.audio.every((x) => x.de === ana.id), 'nadie más se cuela en el canal');
}

// quien no está en el canal de voz no recibe audio
const fuera = await new Promise((res) => {
  const ws = new WebSocket(URL);
  const c = { ws, audio: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: ana.codigo, name: 'Curiose' })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'voz.audio') c.audio.push(m);
  });
  setTimeout(() => res(c), 1500);
});
ok(fuera.audio.length === 0, 'quien no entra al canal de voz no recibe audio');

ana.ws.close();
beto.ws.close();
fuera.ws.close();

console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
process.exit(fallos ? 1 : 0);
