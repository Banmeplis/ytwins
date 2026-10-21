/* Prueba de las salas públicas: cuatro salas fijas, siempre abiertas, en las
 * que cualquiera entra con su nombre (sin código), y salas privadas aparte. */
import WebSocket from 'ws';

const URL = process.env.URL_SALA || 'ws://localhost:3000';
const API = URL.replace(/^ws/, 'http');
let fallos = 0;
const ok = (cond, texto) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + texto);
  if (!cond) fallos++;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function abrir() {
  return new Promise((res) => {
    const ws = new WebSocket(URL);
    const c = { ws, id: null, codigo: null, tipos: new Set() };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: 'SALA03', name: 'Ana' })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      c.tipos.add(m.type);
      if (m.type === 'joined') { c.id = m.userId; c.codigo = m.code; res(c); }
    });
    setTimeout(() => res(c), 4000);
  });
}

// 1) la API lista las cuatro salas públicas
const res = await fetch(`${API}/api/salas/publicas`);
const datos = await res.json();
ok(datos.ok === true, 'la API de salas públicas responde');
ok(datos.salas.length === 4, 'hay exactamente 4 salas públicas (' + datos.salas.length + ')');
ok(datos.salas.every((s) => /^SALA0[1-4]$/.test(s.codigo)), 'los códigos de las salas públicas son SALA01..SALA04');
ok(datos.salas.every((s) => typeof s.personas === 'number' && typeof s.nombre === 'string'), 'cada sala pública trae nombre y número de personas');

// 2) entrar en una sala pública con solo el nombre (la sala no existía)
const ana = await abrir();
ok(!!ana.id, 'se entra en la sala pública SALA03 con solo el nombre');
ok(ana.codigo === 'SALA03', 'el cliente queda en la sala pública correcta (' + ana.codigo + ')');
await espera(400); // el estado compartido llega justo después
ok(ana.tipos.has('state'), 'la sala pública trae el estado compartido');

// 3) otra persona entra en la misma sala pública
const beto = await new Promise((res2) => {
  const ws = new WebSocket(URL);
  const c = { ws, id: null };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: 'SALA03', name: 'Beto' })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'joined') { c.id = m.userId; res2(c); }
  });
  setTimeout(() => res2(c), 4000);
});
ok(!!beto.id, 'una segunda persona entra en la misma sala pública');
await espera(400);
const datos2 = await (await fetch(`${API}/api/salas/publicas`)).json();
const sala3 = datos2.salas.find((s) => s.codigo === 'SALA03');
ok(sala3.personas === 2, 'la sala pública cuenta a las dos personas (' + sala3.personas + ')');

// 4) las salas privadas siguen con su código aleatorio
const privada = await new Promise((res2) => {
  const ws = new WebSocket(URL);
  const c = { ws, id: null, codigo: null };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'create', name: 'Privada', userName: 'Ana' })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'joined') { c.id = m.userId; c.codigo = m.code; res2(c); }
  });
  setTimeout(() => res2(c), 4000);
});
ok(!!privada.id && /^[A-Z2-9]{6}$/.test(privada.codigo || ''), 'la sala privada tiene su código de 6 caracteres (' + privada.codigo + ')');
ok(privada.codigo !== 'SALA01' && privada.codigo !== 'SALA02' && privada.codigo !== 'SALA03' && privada.codigo !== 'SALA04', 'la sala privada no usa los códigos de las públicas');

// 5) un código inexistente sigue dando error
const error = await new Promise((res2) => {
  const ws = new WebSocket(URL);
  let gotten = null;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: 'NOPUCO', name: 'Ana' })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'error') { gotten = m; ws.close(); res2(m); }
  });
  setTimeout(() => res2(gotten), 4000);
});
ok(error?.fatal === true, 'un código que no existe da error claro');

ana.ws.close();
beto.ws.close();
privada.ws.close();
console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
process.exit(fallos ? 1 : 0);
