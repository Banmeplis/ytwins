/* Prueba de la deduplicación: la misma persona (mismo navegador) al volver a
 * entrar no debe aparecer dos veces, y los fantasmas (conexiones muertas con
 * la misma IP) se limpian. */
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
    const c = { ws, id: null, codigo: null, estados: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: 'SALA02', name: 'Ana', clientId: 'navegador-1' })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'joined') { c.id = m.userId; c.codigo = m.code; res(c); }
      if (m.type === 'state') c.estados.push(m);
    });
    setTimeout(() => res(c), 4000);
  });
}

const personas = (c) => {
  const ultimo = c.estados[c.estados.length - 1];
  return ultimo?.users?.map((u) => u.name) || [];
};

// 1) entra Ana
const ana = await abrir();
await espera(400);
ok(!!ana.id, 'Ana entra en la sala');
ok(personas(ana).filter((n) => n === 'Ana').length === 1, 'Ana aparece una sola vez (' + personas(ana).join(', ') + ')');

// 2) entra OTRA persona desde "otro navegador" (otro clientId)
const beto = await new Promise((res) => {
  const ws = new WebSocket(URL);
  const c = { ws, id: null, estados: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: 'SALA02', name: 'Beto', clientId: 'navegador-2' })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'joined') { c.id = m.userId; res(c); }
    if (m.type === 'state') c.estados.push(m);
  });
  setTimeout(() => res(c), 4000);
});
await espera(400);
ok(beto.id && beto.id !== ana.id, 'Beto entra con su propia identidad');
ok(personas(ana).length === 2, 'en la sala hay dos personas (' + personas(ana).join(', ') + ')');

// 3) Ana "se corta" a lo bruto (la conexión muere sin cerrar limpio) y vuelve
//    a entrar: no puede quedar duplicada
ana.ws.terminate();
await espera(300);
const ana2 = await new Promise((res) => {
  const ws = new WebSocket(URL);
  const c = { ws, id: null, estados: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: 'SALA02', name: 'Ana', clientId: 'navegador-1' })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'joined') { c.id = m.userId; res(c); }
    if (m.type === 'state') c.estados.push(m);
  });
  setTimeout(() => res(c), 4000);
});
await espera(500);
ok(ana2.id === ana.id, 'al volver, Ana conserva su identificador (es la misma persona)');
ok(personas(ana2).filter((n) => n === 'Ana').length === 1, 'Ana NO aparece duplicada (' + personas(ana2).join(', ') + ')');
ok(personas(ana2).length === 2, 'siguen siendo dos personas en la sala (' + personas(ana2).join(', ') + ')');

ana2.ws.close();
beto.ws.close();
console.log(fallos === 0 ? '\nTodas las pruebas pasaron ✓' : `\n${fallos} pruebas fallidas`);
process.exit(fallos ? 1 : 0);
