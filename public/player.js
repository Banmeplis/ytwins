/**
 * Reproductor multi-fuente con una interfaz única para la sincronización:
 *
 *   const rep = crearReproductor(fuente, contenedor, cb);
 *   await rep.cargar(item, inicioSegundos);   item = { fuente, ref, url }
 *   rep.reproducir() / rep.pausar() / rep.buscar(t)
 *   rep.tiempo() / rep.duracion() / rep.estado()   → 'idle'|'playing'|'paused'|'buffering'|'ended'
 *   rep.calidad('small'|'medium'|'large'|'hd720')  → mejor esfuerzo según la fuente
 *   rep.destruir()
 *
 * cb = { accionLocal(tipo, tiempo), terminar(), buffer(activo), listo() }
 * `accionLocal` avisa cuando el usuario tocó los controles nativos del reproductor.
 */
(function (global) {
  const cargadores = {};

  function cargarScript(src) {
    if (cargadores[src]) return cargadores[src];
    cargadores[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => res(true);
      s.onerror = () => rej(new Error('No pude cargar ' + src));
      document.head.appendChild(s);
    });
    return cargadores[src];
  }

  function cargarYouTube() {
    if (global.YT && global.YT.Player) return Promise.resolve(true);
    if (!global.__ytPromise) {
      global.__ytPromise = new Promise((res, rej) => {
        const previo = global.onYouTubeIframeAPIReady;
        global.onYouTubeIframeAPIReady = () => { if (previo) previo(); res(true); };
        cargarScript('https://www.youtube.com/iframe_api').catch(rej);
        setTimeout(() => (global.YT && global.YT.Player ? res(true) : rej(new Error('YouTube no respondió'))), 15000);
      });
    }
    return global.__ytPromise;
  }

  const cargarVimeo = () => cargarScript('https://player.vimeo.com/api/player.js');

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------ base */
  class Base {
    constructor(cont, cb) {
      this.cont = cont;
      this.cb = cb || {};
      this.estado = 'idle';
      this.creado = false;
      this.refActual = null;
      this._inicio = 0;
    }
    _nodo() {
      this.cont.innerHTML = '';
      const d = document.createElement('div');
      d.style.width = '100%';
      d.style.height = '100%';
      this.cont.appendChild(d);
      return d;
    }
    /** Reintenta una operación del SDK hasta que el reproductor acepte (15 × 400 ms). */
    async _reintento(fn, n = 15) {
      for (let i = 0; i < n; i++) {
        try { await fn(); return true; } catch { await espera(400); }
      }
      return false;
    }
    tiempo() { return 0; }
    duracion() { return 0; }
    /** ¿Puede el HUD confiar en el reproductor (posición/duración reales)? */
    listo() { return this.creado && this.duracion() > 0; }
    reproducir() {}
    pausar() {}
    buscar() {}
    calidad() {}
    destruir() {
      try { this.p && this.p.destroy && this.p.destroy(); } catch {}
      this.cont.innerHTML = '';
      this.creado = false;
      this.refActual = null;
    }
  }

  /* --------------------------------------------------------- YouTube */
  class RepYouTube extends Base {
    async _asegurar(item) {
      if (this.creado) return;
      await cargarYouTube();
      const nodo = this._nodo();
      this.p = await new Promise((res) => {
        const p = new global.YT.Player(nodo, {
          videoId: item ? item.ref : '',
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: global.location.origin, controls: 1 },
          events: {
            onReady: () => { this.cb.listo && this.cb.listo(); res(p); },
            onStateChange: (e) => this._onEstado(e),
            onError: (e) => this._onError(e),
          },
        });
      });
      this.refActual = item ? item.ref : null;
      this.creado = true;
      if (item && this._inicio > 1) { try { this.p.seekTo(this._inicio, false); } catch {} }
    }
    _onEstado(e) {
      const S = global.YT.PlayerState;
      if (e.data === S.PLAYING) { this.estado = 'playing'; this.cb.buffer && this.cb.buffer(false); this.cb.accionLocal && this.cb.accionLocal('play', this.tiempo()); }
      else if (e.data === S.PAUSED) { this.estado = 'paused'; this.cb.accionLocal && this.cb.accionLocal('pause', this.tiempo()); }
      else if (e.data === S.ENDED) { this.estado = 'ended'; this.cb.terminar && this.cb.terminar(); }
      else if (e.data === S.BUFFERING) { this.estado = 'buffering'; this.cb.buffer && this.cb.buffer(true); }
      else if (e.data === S.CUED || e.data === S.UNSTARTED) this.estado = 'idle';
    }
    _onError(e) {
      const codigos = {
        2: 'El identificador del vídeo no es válido.',
        5: 'Este navegador no puede reproducir el vídeo con HTML5.',
        100: 'El vídeo no existe o es privado.',
        101: 'El autor no permite reproducirlo embebido aquí.',
        150: 'El autor no permite reproducirlo embebido aquí.',
      };
      this.cb.fallo && this.cb.fallo(codigos[e.data] || `YouTube devolvió un error (${e.data}).`);
    }
    async cargar(item, inicio) {
      if (!this.creado) {
        this._inicio = inicio || 0;
        await this._asegurar(item);
        return;
      }
      if (this.refActual !== item.ref) {
        this.refActual = item.ref;
        this._inicio = inicio || 0;
        this.p.loadVideoById(item.ref, Math.max(0, inicio || 0));
      } else if (inicio > 1) {
        try { this.p.seekTo(inicio, true); } catch {}
      }
    }
    reproducir() { try { this.p.playVideo(); } catch {} }
    pausar() { try { this.p.pauseVideo(); } catch {} }
    buscar(t) { try { this.p.seekTo(t, true); } catch {} }
    tiempo() { try { return this.p.getCurrentTime() || 0; } catch { return 0; } }
    duracion() { try { return this.p.getDuration() || 0; } catch { return 0; } }
    calidad(q) {
      // mejor esfuerzo: la API de calidad manual de YouTube es "sugerida"
      try { this.p.setPlaybackQuality && this.p.setPlaybackQuality(q); } catch {}
    }
  }

  /* ----------------------------------------------------------- Vimeo */
  class RepVimeo extends Base {
    async _asegurar(item) {
      if (this.creado) return;
      await cargarVimeo();
      const nodo = this._nodo();
      this._t = 0;
      this._d = 0;
      this.p = new global.Vimeo.Player(nodo, {
        id: item.ref,
        autoplay: false,
        responsive: false,
        title: false,
        portrait: false,
        byline: false,
      });
      this.p.on('play', () => { this.estado = 'playing'; this.cb.accionLocal && this.cb.accionLocal('play', this.tiempo()); });
      this.p.on('pause', () => { this.estado = 'paused'; this.cb.accionLocal && this.cb.accionLocal('pause', this.tiempo()); });
      this.p.on('ended', () => { this.estado = 'ended'; this.cb.terminar && this.cb.terminar(); });
      this.p.on('waiting', () => { this.estado = 'buffering'; this.cb.buffer && this.cb.buffer(true); });
      this.p.on('playing', () => { this.estado = 'playing'; this.cb.buffer && this.cb.buffer(false); });
      this.p.on('timeupdate', (d) => { this._t = d.seconds; });
      this.p.on('loaded', () => this._pedirDuracion());
      const fallo = (e) =>
        this.cb.fallo &&
        this.cb.fallo('Vimeo: ' + ((e && e.message) || 'no se pudo cargar el vídeo (¿eliminado o privado?)'));
      this.p.on('error', fallo);
      this.p.on('loaderror', fallo);
      this.refActual = item.ref;
      this.creado = true;
      this._pedirDuracion();
      this._posicionInicial();
      this.cb.listo && this.cb.listo();
    }
    _pedirDuracion() {
      this._reintento(() => this.p.getDuration())
        .then((ok) => ok && this.p.getDuration().then((d) => { this._d = d || this._d; }).catch(() => {}));
    }
    async _posicionInicial() {
      const t = this._inicio || 0;
      if (t > 1) await this._reintento(() => this.p.setCurrentTime(t));
    }
    async cargar(item, inicio) {
      if (!this.creado) {
        this._inicio = inicio || 0;
        await this._asegurar(item);
        return;
      }
      if (this.refActual !== item.ref) {
        // recrear es más fiable que loadVideo: el SDK anterior puede estar inmovilizado
        await this._recrear(item, inicio);
        return;
      }
      if (inicio > 1) {
        this._inicio = inicio;
        this._posicionInicial();
      }
    }
    async _recrear(item, inicio) {
      this._inicio = inicio || 0;
      try { this.p.destroy(); } catch {}
      this.cont.innerHTML = '';
      this.creado = false;
      this.estado = 'idle';
      await this._asegurar(item);
    }
    reproducir() { this.p && this.p.play().catch(() => {}); }
    pausar() { this.p && this.p.pause().catch(() => {}); }
    buscar(t) { this.p && this.p.setCurrentTime(t).catch(() => {}); }
    tiempo() { return this._t || 0; }
    duracion() { return this._d || 0; }
  }

  /* ----------------------------------------------------- Dailymotion
   * Dailymotion ya no publica un SDK con API abierta para terceros: se usa
   * su iframe oficial (geo.dailymotion.com) con parámetros de URL (autoplay,
   * start). Como el iframe no acepta comandos en caliente, play/pausa/seek
   * se resuelven recreando el iframe con el tiempo ya posicionado.
   * La duración/título llegan del servidor (API pública de Dailymotion).
   */
  class RepDM extends Base {
    _asegurar(item) {
      if (this.creado) return;
      this._nodo();
      this._t = this._inicio || 0;
      this._d = item.duration || 0;
      this._marca = 0;
      this._vaA = true;
      this._item = item;
      this.refActual = item.ref;
      this.creado = true;
      this._montar(true);
    }
    _montar(reproduciendo) {
      const nodo = this.cont.firstElementChild;
      if (!nodo || !this._item) return;
      this._vaA = reproduciendo;
      const q = new URLSearchParams({
        video: this._item.ref,
        autoplay: reproduciendo ? '1' : '0',
        controls: '1',
        'ui-start-screen-rel': '0',
        start: String(Math.max(0, Math.floor(this._t || 0))),
      });
      const f = document.createElement('iframe');
      f.src = 'https://geo.dailymotion.com/player.html?' + q.toString();
      f.allow = 'autoplay; fullscreen; picture-in-picture';
      f.setAttribute('allowfullscreen', '');
      f.style.cssText = 'width:100%;height:100%;border:0;background:#000';
      f.addEventListener('load', () => {
        this._marca = Date.now();
        this.estado = reproduciendo ? 'playing' : 'paused';
        if (reproduciendo) this.cb.buffer && this.cb.buffer(false);
        this.cb.listo && this.cb.listo();
      });
      nodo.innerHTML = '';
      nodo.appendChild(f);
      this._iframe = f;
      this.estado = 'buffering';
      if (reproduciendo) this.cb.buffer && this.cb.buffer(true);
    }
    async cargar(item, inicio) {
      if (!this.creado) {
        this._inicio = inicio || 0;
        this._asegurar(item);
        return;
      }
      this._item = item;
      this.refActual = item.ref;
      this._t = Math.max(0, inicio || 0);
      if (item.duration) this._d = item.duration;
      this._marca = 0;
      this._montar(true);
    }
    reproducir() {
      if (this._vaA) return;
      this._t = this.tiempo();
      this._marca = 0;
      this._montar(true);
    }
    pausar() {
      if (!this._vaA && this.estado === 'paused') return;
      this._t = this.tiempo();
      this._marca = 0;
      this._montar(false);
    }
    buscar(t) {
      this._t = Math.max(0, t || 0);
      this._marca = 0;
      this._montar(this._vaA);
    }
    tiempo() {
      if (this._vaA && this._marca) return this._t + (Date.now() - this._marca) / 1000;
      return this._t || 0;
    }
    duracion() { return this._d || 0; }
    listo() { return this.creado && !!this._iframe; }
    destruir() {
      this.cont.innerHTML = '';
      this.creado = false;
      this._iframe = null;
      this.refActual = null;
    }
  }

  /* ------------------------------------------------------- .mp4 directo */
  class RepDirecto extends Base {
    _asegurar() {
      if (this.creado) return;
      const nodo = this._nodo();
      this.p = document.createElement('video');
      this.p.controls = true;
      this.p.preload = 'metadata';
      this.p.playsInline = true;
      this.p.style.width = '100%';
      this.p.style.height = '100%';
      this.p.style.background = '#000';
      nodo.appendChild(this.p);
      this.p.addEventListener('play', () => { this.estado = 'playing'; this.cb.accionLocal && this.cb.accionLocal('play', this.tiempo()); });
      this.p.addEventListener('pause', () => { if (this.estado !== 'ended') { this.estado = 'paused'; this.cb.accionLocal && this.cb.accionLocal('pause', this.tiempo()); } });
      this.p.addEventListener('ended', () => { this.estado = 'ended'; this.cb.terminar && this.cb.terminar(); });
      this.p.addEventListener('waiting', () => { this.estado = 'buffering'; this.cb.buffer && this.cb.buffer(true); });
      this.p.addEventListener('playing', () => { this.estado = 'playing'; this.cb.buffer && this.cb.buffer(false); });
      this.p.addEventListener('error', () => this.cb.fallo && this.cb.fallo('No se pudo cargar el archivo de vídeo.'));
      this.creado = true;
    }
    async cargar(item, inicio) {
      this._asegurar();
      if (this.refActual !== item.url) {
        this.refActual = item.url;
        this.p.src = item.url;
        this.estado = 'idle'; // el estado "ended" del vídeo anterior no arrastra
      }
      if (inicio > 1) { try { this.p.currentTime = inicio; } catch {} }
    }
    reproducir() { try { this.p.play(); } catch {} }
    pausar() { try { this.p.pause(); } catch {} }
    buscar(t) { try { this.p.currentTime = t; } catch {} }
    tiempo() { return this.p ? this.p.currentTime || 0 : 0; }
    duracion() { return this.p && isFinite(this.p.duration) ? this.p.duration : 0; }
  }

  const CREADORES = { youtube: RepYouTube, vimeo: RepVimeo, dailymotion: RepDM, directo: RepDirecto };

  global.crearReproductor = function (fuente, contenedor, cb) {
    const Clase = CREADORES[fuente] || RepDirecto;
    return new Clase(contenedor, cb);
  };

  global.CALIDADES = {
    small: '240p',
    medium: '360p',
    large: '480p',
    hd720: '720p',
    hd1080: '1080p',
  };
})(window);
