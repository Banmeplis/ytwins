# YTwins — mira con amigos en la misma sala

App web para crear una sala con un código de 6 letras y ver vídeos **sincronizados**:
el mismo vídeo, en el mismo segundo, con chat, cola, buscador integrado y plugins de sala.

> El paquete se llama `ytwins`. La carpeta de este ejemplo se llama
> `youtube-room` por herencia del proyecto original; puedes renombrarla a
> `ytwins` sin que nada se rompa (la estructura es la misma).

## Requisitos

- Node.js 20 o superior (probado con Node 24)
- Navegador con internet

## Arrancar

```bash
cd youtube-room
npm install
npm start
```

Abre <http://localhost:3000>.

## Probar

Con el servidor arrancado, en otra terminal:

```bash
npm test              # todo (protocolo + fuentes + persistencia + base de datos)
npm run test:protocolo  # 30 pruebas de protocolo de sala
npm run test:fuentes    # 29 pruebas de fuentes, metadatos y /api/search
npm run test:persistencia  # 33 pruebas de guardado/carga de salas
```

## Cómo se usa

1. Escribe tu nombre y pulsa **Crear sala** → obtienes un código de 6 letras.
2. Comparte el código (el botón lo copia). Tus amigos pulsan **Unirse**.
3. **🔍 Busca vídeos dentro de la app** (sin claves de API) o pega un enlace en
   la pestaña **Cola**. Pulsa **▶ Ver** para reproducir ya o **+ Cola**.
4. El anfitrión controla reproducción y cola; puede **Dar control**, cambiar los
   permisos (**Solo anfitrión** / **Todos**) o expulsar.
5. Cualquiera puede chatear, añadir a la cola, reaccionar y votar **✋ Saltar**.
6. Las **encuestas**, las **notas compartidas** y los interruptores de plugins
   viven en el desplegable **✨ Extras** de la barra lateral (el chat queda
   siempre a la vista). Extras se abre solo cuando alguien abre una encuesta.

Atajos: `Espacio` reproduce/pausa.

## Fuentes de vídeo

| Fuente | Reproducción | Metadatos | Notas |
|---|---|---|---|
| YouTube | YouTube IFrame API (control total) | oEmbed (título, canal, miniatura) | probado |
| Vimeo | Player SDK de Vimeo (control total) | oEmbed (título, duración, miniatura) | probado |
| Dailymotion | iframe oficial `geo.dailymotion.com` con `autoplay`/`start` | API pública (título, duración, miniatura) | mejor esfuerzo: el iframe no acepta comandos en caliente, así que play/pausa/seek recrean el iframe ya posicionado |
| `.mp4` / `.webm` / `.m3u8` | `<video>` nativo del navegador | nombre del archivo | control total |

Admite: `youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/`, `/embed/`, ID de 11
caracteres, `vimeo.com/{id}`, `player.vimeo.com/video/{id}`, `dailymotion.com/video/{id}`,
`dai.ly/{id}` y enlaces directos a archivo.

## Buscador sin clave

`GET /api/search?q=texto` consulta la página de resultados de **YouTube desde el
servidor** (evita el CORS del navegador), extrae `videoId`, título, duración,
canal, vistas y miniatura, y lo guarda **5 min en caché**. Los metadatos de cada
vídeo añadido se piden por oEmbed/API con **30 min de caché**.

Sin resultados o caído YouTube → la app lo avisa y puedes pegar el enlace a mano.

## Plugins de sala

Se activan/desactivan desde el panel **Plugins** (solo el anfitrión):

| Plugin | Qué hace | Mensajes |
|---|---|---|
| **Encuestas** | Pregunta + opciones, votos en vivo con barras, el voto propio solo lo ve quien vota | `poll.create`, `poll.vote`, `poll.close` |
| **Notas compartidas** | Bloc de texto que ve toda la sala (edita quien controla) | `notes.set` |
| **Reacciones** | Emojis que vuelan sobre el vídeo (anti-spam 700 ms) | `reaction` |
| **Voz** | Micrófono en tiempo real con WebRTC (malla P2P) | `voz.join`, `voz.leave`, `voz.mute`, `voz.habla`, `voz.senales` |

## Chat de voz en tiempo real

El botón **🎙️ Voz** de la barra superior abre un canal de audio para la sala:

- **WebRTC en malla**: cada persona manda su audio directamente a las demás.
  El servidor no transporta sonido, solo reenvía la *señalización* (ofertas,
  respuestas y candidatos ICE) que ya viaja por el WebSocket de la sala.
- Un clic en **🎙️ Voz** entra al canal (el navegador pide permiso de micrófono).
  Con el micro ya abierto: un clic **silencia/ reactiva**, y **Shift+clic**
  sale del canal del todo.
- En la lista de participantes cada uno con micro muestra 🎙️ o 🔇, y su nombre
  **se ilumina en verde mientras habla** (detección de volumen con Web Audio).
- Se activa con eco cancelación y supresión de ruido, para que no se pisen
  entre sí al hablar.
- Al quien entra es a quien le toca crear las conexiones, así nunca hay dos
  ofertas cruzadas ni se lían las manos. Si el servidor se reinicia, los que
  estaban en el canal vuelven a entrar solos.
- Cerrar la pestaña o salir de la sala apaga el micrófono y cierra las conexiones.
- El anfitrión puede desactivar el plugin **Voz** para una sala.

Detalles honestos:

- Al ser una malla, cada persona manda N copias de su voz (N = gente en el
  canal). Se nota a partir de ~6-7 personas; el canal avisa al llegar a 12.
- Solo se usan servidores **STUND** públicos para descubrir la dirección externa.
  En redes muy restrictivas (algunos móviles y redes corporativas) puede hacer
  falta un servidor **TURN**, que no se puede montar en el alojamiento gratuito.
- Necesitas HTTPS (o `localhost`) para que el navegador dé el micrófono:
  `cloudflared tunnel --url http://localhost:3000` ya sirve, porque por
  delante hay HTTPS.

### Añadir un plugin propio

`server/plugins.js` exporta un registro; cada plugin declara:

```js
{
  id: 'miPlugin',                 // identificador
  nombre: 'Mi Plugin',            // nombre visible
  descripcion: 'Qué hace',        // ayuda en el panel
  inicializar(room) {},           // estado por sala
  manejar({ room, user, msg, enviar, broadcast, puedeControlar }) {
    if (msg.type !== 'mi-accion') return false;   // ¿era mío?
    // ... lógica ...
    broadcast();                    // o enviar(user.ws, {...})
    return true;
  },
  serializar(room) { return { ... }; },  // porción del estado compartido
}
```

Añádelo al array `plugins` y regístralo en `TIPOS_PLUGIN` (tipo de mensaje → id).
No hace falta tocar el resto del servidor ni del cliente: el catálogo viaja en el
estado y el cliente monta los controles.

## Conexión baja: calidad automática

- Lee `navigator.connection` (`effectiveType`, `downlink`) y elige
  **240p / 360p / 480p / 720p**; el chip de la sala muestra la calidad actual.
- Si el reproductor acumula **2+ buffering** en los últimos segundos, baja un peldaño.
- Se reevalúa cada **20 s** y al cambiar las condiciones.
- WebSocket con **reconexión automática** (5 intentos, espera 1→12 s): si se cae
  la red, la sala vuelve sola y el chat/cola no se pierden.
- Miniaturas pequeñas (`mqdefault`, 320×180) y `loading="lazy"`.

## Cómo se mantiene la sincronización

- El servidor guarda el estado autoritativo de reproducción
  (`posición + playing + marca de tiempo`), no el reproductor de nadie.
- Cada cliente calcula en vivo `posición + (ahora - marca) / 1000`.
- Si el desfase local supera **1,5 s**, el cliente hace `seek` automático,
  salvo que seas quien controla y el salto sea un gesto tuyo: si tu posición
  local salta más de **5 s** de un segundo a otro (moviste la barra del propio
  vídeo), se adopta tu posición y se avisa al servidor en vez de devolverte
  atrás. Así adelantar/retroceder funciona con la barra de la app **y** con la
  del reproductor.
- Solo quien controla (anfitrión, o todos si el permiso es **Todos**) puede
  mover la posición; al resto se le corrige a la posición de la sala.
- Cada **10 s** el servidor emite un `sync` para corregir derivas.
- Si el navegador bloquea el autoplay (Vimeo, `<video>`), aparece el botón
  **▶ Toca para reproducir** que aporta el gesto.

## Acceso desde otros dispositivos

**Misma red (wifi/casa):** el servidor escucha en todas las interfaces.
Comparte `http://TU_IP_LOCAL:3000` (mira la IP con `ipconfig`).

**Desde fuera:** usa un túnel, por ejemplo:

```bash
# Cloudflare (gratis, sin registro)
cloudflared tunnel --url http://localhost:3000

# o ngrok
ngrok http 3000
```

Los participantes abren la URL que te devuelven y entran con el código.

## Persistencia: las salas sobreviven a un reinicio

El servidor guarda las salas en `data/salas.json` (escritura atómica, con
1,2 s de rebote para no escribir en cada tecla). Al arrancar las restaura:
cola, vídeo en reproducción con su posición, chat, notas, encuesta con sus
votos y los permisos. **Nadie se conecta automáticamente**: cada persona
abre la página y se reúne con su nombre; el token que guarda el navegador
hace que quien creó la sala recupere el rol de anfitrión sin más.

Detalles:

- La posición se **congela** al guardar: el tiempo que el servidor estuvo
  parado no se cuenta como reproducción.
- Las salas vacías y sin vídeo, abandonadas más de 24 h, no se restauran.
- Si el archivo se corrompe, el servidor avisa por consola y empieza vacío
  en lugar de fallar.
- `Ctrl+C` fuerza la escritura antes de salir.
- Para empezar de cero: borra `data/salas.json`.

La pestaña, además, **reintenta la conexión sin límite de intentos** (con
techo de 10 s), así que un reinicio del servidor se recupera solo: vuelves
a la misma sala con todo lo que había.

## Alojarlo gratis en internet

La app necesita un **servidor Node con WebSockets**, así que un alojamiento
"estático" (GitHub Pages, Netlify, Cloudflare Pages) **no sirve**: solo sirven
archivos y no ejecutan código de servidor. Las opciones reales:

| Opción | Precio | WebSockets | Sin tarjeta | Notas |
|---|---|---|---|---|
| **Render.com** | gratis (750 h/mes) | ✅ | ✅ | Duerme a los 15 min sin actividad; despierta en ~60 s |
| Túnel (cloudflared) | gratis | ✅ | ✅ | URL temporal; tu PC debe estar encendida |
| Railway / Fly.io | crédito/trial | ✅ | ❌ | Piden tarjeta o se agota el crédito |

### Pasos con Render (lo más fácil y gratis)

1. Crea una cuenta en [github.com](https://github.com) y sube esta carpeta
   como repositorio (o usa la app **GitHub Desktop**, que no necesita
   comandos).
2. En [render.com](https://render.com) → **New → Blueprint** → conecta ese
   repositorio. Detecta el `render.yaml` y crea el servicio solo.
3. En ~2 min tienes una URL pública tipo
   `https://ytwins-xxxx.onrender.com`. Comparte esa URL: tus amigos
   entran con el código de la sala, sin instalar nada.

Lo que ya está preparado para ello:

- `render.yaml` (Blueprint: build `npm install`, arranque `npm start`, health check en `/api/health`).
- El servidor lee `PORT` del entorno (Render lo asigna solo).
- **Latido `ping`/`pong`** cada 4 min desde el cliente: mientras haya gente
  en la sala, la app no se duerme.
- **Persistencia en base de datos** si defines `DATABASE_URL` (ver abajo);
  si no, guarda en `data/salas.json`, que en Render vive en el disco
  temporal y **se borra en cada despliegue nuevo**.

### Base de datos para que las salas sean permanentes

Si defines la variable de entorno **`DATABASE_URL`** (una URL de
PostgreSQL tipo `postgres://...`), el servidor guarda las salas ahí en vez
de en el archivo, y sobreviven a despliegues y reinicios. Sin ella, sigue
funcionando con el archivo local: **no hay que cambiar nada de código**.

En Render: **New → PostgreSQL** (gratis, se elimina a los 90 días) y en el
servidor web añade la variable `DATABASE_URL` con la conexión que te da.
También valen Supabase o Neon (planes gratuitos permanentes).

Cómo funciona por dentro:

- Tabla `salas (code TEXT PRIMARY KEY, datos JSONB, actualizado BIGINT)`;
  se crea sola al arrancar, sin migraciones.
- Guardado con `INSERT … ON CONFLICT … DO UPDATE` (upsert) por sala, con el
  mismo rebote de 1,2 s que el archivo.
- Cada hora borra las salas vacías y abandonadas más de 24 h.
- Si la base no responde, avisa por consola y **sigue con el archivo local**
  en lugar de caerse.

### Túnel sin registrarse (para probar hoy mismo)

Con tu PC encendida y el servidor arrancado:

```bash
cloudflared tunnel --url http://localhost:3000
```

Te da una URL pública temporal que compartes mientras dure la sesión.

## Estructura

```
youtube-room/   (o ytwins/, si renombras la carpeta)
├─ server/
│  ├─ index.js        HTTP + WebSocket, salas, roles, cola, sync, /api/search
│  ├─ fuentes.js      clasificación de enlaces, metadatos, buscador
│  ├─ plugins.js      registro de plugins (encuestas, notas, reacciones, voz)
│  └─ persistencia.js salas en data/salas.json o en PostgreSQL (DATABASE_URL)
├─ public/
│  ├─ index.html      lobby y vista de sala
│  ├─ styles.css
│  ├─ app.js          cliente, sincronización, buscador, plugins, calidad
│  ├─ player.js       reproductor multi-fuente (YouTube/Vimeo/Dailymotion/directo)
│  └─ voz.js          chat de voz WebRTC (señalización + malla de audio)
├─ render.yaml        despliegue gratis en Render (Blueprint)
└─ test/
   ├─ protocolo.mjs        45 pruebas del protocolo de sala
   ├─ extensiones.mjs      29 pruebas de fuentes, metadatos y búsqueda
   ├─ persistencia.mjs     33 pruebas de guardado/carga en archivo
   └─ persistencia_pg.mjs  27 pruebas del almacén PostgreSQL
```

## Protocolo (JSON por WebSocket)

| Cliente → Servidor | Servidor → Cliente |
|---|---|
| `create`, `join` | `joined`, `state` (estado completo), `sync` (posiciones) |
| `chat`, `queue.add/remove/play/next` | `error`, `kicked` |
| `playback` (`play`/`pause`/`seek`) | `reaccion` (evento efímero) |
| `role.set`, `kick`, `policy`, `skip.vote` | `plugin` (`miVoto`, privado) |
| `plugin.toggle`, `poll.*`, `notes.set`, `reaction` | `voz.lista`, `voz.habla` (eventos efímeros) |
| `voz.join/leave/mute/habla/senales` | `voz.senales` (señalización reenviada) |

Endpoints: `GET /api/search?q=…`, `GET /api/health`.

## Limitaciones y siguientes pasos

- Las salas sobreviven al reinicio (archivo o PostgreSQL), pero **el canal de
  voz no**: al reiniciar el servidor hay que volver a pulsar 🎙️.
- La voz es una malla WebRTC: se nota a partir de ~6-7 personas en el canal y
  en redes muy restrictivas haría falta un servidor TURN (no disponible en el
  alojamiento gratuito).
- Dailymotion depende de su iframe: sin API de comandos, el anfitrión no puede
  pausar en caliente para el grupo sin recargar el iframe (funciona, pero con ~1 s de latencia).
- El buscador lee la página pública de YouTube; si YouTube cambia el HTML o
  bloquea peticiones automáticas, avisa y queda el modo "pegar enlace".
- Votos para saltar: umbral de la mitad de los que no controlan.
- Pendiente: calidad automática medida con `getBytesReceived` y poder elegir
  quién "manda la voz" si molesta el eco.

## Nota legal

Los reproductores incrustados son los oficiales de YouTube/Vimeo/Dailymotion.
El uso queda sujeto a sus Términos de Servicio: no se descarga ni redistribuye
vídeos. La búsqueda consulta la página pública de resultados sin claves de API.
