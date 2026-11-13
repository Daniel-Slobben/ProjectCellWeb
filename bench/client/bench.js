// Drawing bench for CellWeb. bench/server.mjs injects this as the first script in <head>, so the hooks
// below are in place before the app creates its canvas context, workers and STOMP socket. Nothing in
// the app is changed: input is synthesised as DOM events on the canvas and everything is measured from
// the outside.
//
// URL parameters:
//   ?bench=<scenario>  run one scenario on load (the page reloads between scenarios)
//   &run=<id>          result file to append to (bench/results/<id>.json)
//   &duration=<ms>     measuring time per scenario (default 6000)
//   &auto=1            set by the CLI runner: do not navigate on, just publish window.__benchResult
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const QUEUE_KEY = 'cellweb-bench-queue';
  const BASELINE_KEY = 'cellweb-bench-baseline';
  const now = () => performance.now();
  const nativeRaf = window.requestAnimationFrame.bind(window);

  // ===================================================================================================
  // Hooks. Each one only appends to plain arrays/counters; summaries are computed after the run.
  // ===================================================================================================

  const rec = {
    on: false,
    reset() {
      this.on = false;
      // When our frame callback ran. Not the rAF timestamp: Chrome passes the frame's begin time, which
      // can predate a long task that delayed the callback, and would then pin the delay on the next frame.
      this.frames = [];
      this.frameWork = [];       // per frame interval ending at frames[i]: {app, ws, commit} main-thread ms
      this.appRaf = [];          // ms spent in the app's rAF callbacks, one entry per frame they ran
      this.drawFrames = [];      // per frame in which the app drew: {t, app, calls, canvasMs, srcPx, newPx, cover}
      this.drawToScreen = [];    // ms from the socket message to the first draw of a bitmap it produced
      this.wsMsgs = [];          // main-thread socket handling: {t, bytes, handlerMs}
      this.socketMsgs = [];      // socket messages handled in a worker (from worker-hook.js): {t, bytes, ms}
      this.workerReplies = [];   // {t, handlerMs, bitmaps, px}
      this.batches = [];         // {type, latency, wsDelay}
      this.inputLatency = [];    // ms from an input event to the next app draw
      this.inputs = 0;
      this.cellSizes = [];
      this.bitmapWidths = new Set();
      this.liveBitmapPxPeak = 0;
      this.loaf = [];
      this.canvasPx = 0;
    },
  };
  rec.reset();

  const state = {
    canvas: null,
    blockSize: 0,
    cellSize: NaN,
    lastDrawAt: 0,
    drawSeq: 0,               // frames in which the app drew
    coverage: 0,
    pendingInputAt: null,
    currentWs: null,         // {t} while a socket message handler runs
    liveBitmaps: new Set(),
    liveBitmapPx: 0,
    bitmapOrigin: new WeakMap(), // bitmap -> socket message time (or reply time)
    seenBitmaps: new WeakSet(),
    batchesById: new Map(),
    frame: {calls: 0, canvasMs: 0, srcPx: 0, newPx: 0, coverPx: 0},
  };

  // --- requestAnimationFrame: time the app's callbacks ---
  // Main-thread time per frame interval, by source. Our frame callback runs before the app's in every
  // frame (it registered first), so work counted here happened between the previous frame and this one.
  let appRafThisFrame = 0, wsThisFrame = 0, commitThisFrame = 0;
  window.requestAnimationFrame = function (callback) {
    return nativeRaf((ts) => {
      const t0 = now();
      try {
        callback(ts);
      } finally {
        appRafThisFrame += now() - t0;
      }
    });
  };

  // --- canvas: count draws, source/new pixels and covered area; infer cellSize ---
  const C2D = CanvasRenderingContext2D.prototype;
  const nativeDrawImage = C2D.drawImage;
  C2D.drawImage = function (image) {
    const t0 = now();
    const result = nativeDrawImage.apply(this, arguments);
    const t1 = now();
    // The app's canvas is the first on-page canvas that draws an image.
    if (!state.canvas && this.canvas.isConnected) state.canvas = this.canvas;
    if (this.canvas !== state.canvas) return result;
    const f = state.frame;
    f.calls++;
    f.canvasMs += t1 - t0;
    const a = arguments;
    let sw, sh, dx, dy, dw, dh;
    const iw = image.width, ih = image.height;
    if (a.length >= 9) { sw = a[3]; sh = a[4]; dx = a[5]; dy = a[6]; dw = a[7]; dh = a[8]; }
    else if (a.length >= 5) { sw = iw; sh = ih; dx = a[1]; dy = a[2]; dw = a[3]; dh = a[4]; }
    else { sw = iw; sh = ih; dx = a[1]; dy = a[2]; dw = iw; dh = ih; }
    f.srcPx += sw * sh;
    if (!state.seenBitmaps.has(image)) {
      state.seenBitmaps.add(image);
      f.newPx += iw * ih;
      const origin = state.bitmapOrigin.get(image);
      if (rec.on && origin !== undefined) rec.drawToScreen.push(t1 - origin);
    }
    // Area in device pixels, clipped to the canvas. Blocks do not overlap, so the sum is the union.
    const m = this.getTransform();
    const x0 = Math.max(0, m.a * dx + m.e), x1 = Math.min(this.canvas.width, m.a * (dx + dw) + m.e);
    const y0 = Math.max(0, m.d * dy + m.f), y1 = Math.min(this.canvas.height, m.d * (dy + dh) + m.f);
    if (x1 > x0 && y1 > y0) f.coverPx += (x1 - x0) * (y1 - y0);
    // One block per drawImage today: destination width = blockSize * cellSize in device pixels.
    // If drawing moves to tiles, this is the one place that needs to learn the tile size.
    if (state.blockSize) state.cellSize = (dw * m.a) / devicePixelScale() / state.blockSize;
    if (rec.on) rec.bitmapWidths.add(iw);
    return result;
  };
  for (const name of ['clearRect', 'fillRect', 'strokeRect', 'putImageData']) {
    const native = C2D[name];
    C2D[name] = function () {
      const t0 = now();
      const result = native.apply(this, arguments);
      if (this.canvas === state.canvas) state.frame.canvasMs += now() - t0;
      return result;
    };
  }
  /** Device pixels per CSS pixel the app renders at: backing width over the CSS width it set. */
  function devicePixelScale() {
    const c = state.canvas;
    const cssWidth = c ? parseFloat(c.style.width) || c.clientWidth : 0;
    return cssWidth ? c.width / cssWidth : Math.ceil(devicePixelRatio);
  }

  // --- WebSocket: message sizes and time spent in the STOMP handler (parse + dispatch to workers) ---
  const NativeWebSocket = window.WebSocket;
  const wsOnMessage = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage');
  class BenchWebSocket extends NativeWebSocket {}
  if (wsOnMessage) Object.defineProperty(BenchWebSocket.prototype, 'onmessage', {
    configurable: true,
    get() { return wsOnMessage.get.call(this); },
    set(fn) {
      wsOnMessage.set.call(this, typeof fn !== 'function' ? fn : function (event) {
        const t0 = now();
        state.currentWs = {t: t0};
        try {
          return fn.call(this, event);
        } finally {
          state.currentWs = null;
          wsThisFrame += now() - t0;
          const bytes = typeof event.data === 'string' ? event.data.length : event.data.byteLength;
          if (rec.on) rec.wsMsgs.push({t: t0, bytes, handlerMs: now() - t0});
        }
      });
    },
  });
  window.WebSocket = BenchWebSocket;

  // --- Workers: batch latency, bitmaps produced, time spent committing replies ---
  const NativeWorker = window.Worker;
  const workerOnMessage = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage');
  class BenchWorker extends NativeWorker {
    postMessage(message) {
      if (message && typeof message === 'object' && 'batchId' in message) {
        let batch = state.batchesById.get(message.batchId);
        if (!batch) {
          batch = {type: message.type, t: now(), wsAt: state.currentWs?.t ?? null, posts: 0, replies: 0};
          state.batchesById.set(message.batchId, batch);
        }
        batch.posts++;
      }
      return super.postMessage(...arguments);
    }
  }
  if (workerOnMessage) Object.defineProperty(BenchWorker.prototype, 'onmessage', {
    configurable: true,
    get() { return workerOnMessage.get.call(this); },
    set(fn) {
      workerOnMessage.set.call(this, typeof fn !== 'function' ? fn : function (event) {
        const t0 = now();
        const data = event.data;
        // An event the socket worker posted while handling a socket message (tagged by worker-hook.js):
        // main-thread socket handling, and the origin for the batches it dispatches.
        const socketAt = data && typeof data === 'object' && typeof data.__benchSocketAt === 'number'
          ? data.__benchSocketAt - performance.timeOrigin : null;
        if (socketAt !== null) state.currentWs = {t: socketAt};
        let bitmaps = 0, px = 0;
        const batch = data && typeof data === 'object' ? state.batchesById.get(data.batchId) : undefined;
        if (batch && Array.isArray(data.results)) {
          for (const r of data.results) {
            const bmp = r && r.bitmap;
            if (!bmp) continue;
            bitmaps++;
            px += bmp.width * bmp.height;
            state.liveBitmaps.add(bmp);
            state.liveBitmapPx += bmp.width * bmp.height;
            if (batch.type === 'payload' && batch.wsAt !== null) state.bitmapOrigin.set(bmp, batch.wsAt);
          }
        }
        try {
          return fn.call(this, event);
        } finally {
          const t1 = now();
          if (batch) {
            batch.replies++;
            if (batch.replies === batch.posts) {
              state.batchesById.delete(data.batchId);
              if (rec.on) rec.batches.push({type: batch.type, latency: t1 - batch.t, fromWs: batch.wsAt === null ? null : t1 - batch.wsAt});
            }
          }
          if (socketAt !== null) {
            state.currentWs = null;
            wsThisFrame += t1 - t0;
            if (rec.on) rec.wsMsgs.push({t: t0, bytes: 0, handlerMs: t1 - t0});
          }
          if (batch) commitThisFrame += t1 - t0;
          if (rec.on && batch) rec.workerReplies.push({t: t0, handlerMs: t1 - t0, bitmaps, px});
          if (rec.on) rec.liveBitmapPxPeak = Math.max(rec.liveBitmapPxPeak, state.liveBitmapPx);
        }
      });
    },
  });
  window.Worker = BenchWorker;

  const nativeClose = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function () {
    if (state.liveBitmaps.delete(this)) state.liveBitmapPx -= this.width * this.height;
    return nativeClose.call(this);
  };

  try {
    new BroadcastChannel('cellweb-bench').onmessage = (e) => {
      if (rec.on && e.data?.kind === 'socket') rec.socketMsgs.push({t: e.data.at - performance.timeOrigin, bytes: e.data.bytes, ms: e.data.ms});
    };
  } catch { /* no BroadcastChannel */ }

  // --- Long Animation Frames (Chromium only) ---
  let loafSupported = false;
  try {
    if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      loafSupported = true;
      new PerformanceObserver((list) => {
        if (!rec.on) return;
        for (const e of list.getEntries()) {
          const scripts = (e.scripts ?? []).map((s) => ({invoker: s.invoker || s.invokerType, ms: s.duration, layout: s.forcedStyleAndLayoutDuration ?? 0}));
          rec.loaf.push({duration: e.duration, blocking: e.blockingDuration ?? 0,
            render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
            styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, scripts});
        }
      }).observe({type: 'long-animation-frame'});
    }
  } catch { /* not supported */ }

  // --- our own frame loop: closes each frame's counters ---
  function frameLoop() {
    const ts = now();
    const f = state.frame;
    if (f.calls > 0) {
      const total = state.canvas ? state.canvas.width * state.canvas.height : 0;
      state.coverage = total ? f.coverPx / total : 0;
      state.lastDrawAt = now();
      state.drawSeq++;
      if (rec.on) {
        rec.drawFrames.push({t: ts, app: appRafThisFrame, calls: f.calls, canvasMs: f.canvasMs, srcPx: f.srcPx, newPx: f.newPx, cover: state.coverage});
        if (state.pendingInputAt !== null) rec.inputLatency.push(now() - state.pendingInputAt);
      }
      state.pendingInputAt = null;
      if (rec.on && Number.isFinite(state.cellSize)) rec.cellSizes.push(state.cellSize);
    }
    if (rec.on) {
      rec.frames.push(ts);
      rec.frameWork.push({app: appRafThisFrame, ws: wsThisFrame, commit: commitThisFrame});
      if (appRafThisFrame > 0) rec.appRaf.push(appRafThisFrame);
    }
    appRafThisFrame = 0;
    wsThisFrame = 0;
    commitThisFrame = 0;
    state.frame = {calls: 0, canvasMs: 0, srcPx: 0, newPx: 0, coverPx: 0};
    hud.update();
    nativeRaf(frameLoop);
  }
  nativeRaf(frameLoop);

  // ===================================================================================================
  // Input synthesis. Positions are a function of wall time, so when the main thread stalls the next
  // event jumps further, like real input that piles up behind a long frame.
  // ===================================================================================================

  const INPUT_HZ = 120;
  let pointerDown = false;

  function canvasPoint(x, y) {
    const r = state.canvas.getBoundingClientRect();
    return {clientX: r.left + x, clientY: r.top + y};
  }
  function markInput() {
    rec.inputs++;
    if (state.pendingInputAt === null) state.pendingInputAt = now();
  }
  function mouse(type, x, y) {
    const p = canvasPoint(x, y);
    const pointerType = {mousedown: 'pointerdown', mousemove: 'pointermove', mouseup: 'pointerup'}[type];
    const init = {...p, bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      buttons: type === 'mouseup' ? 0 : 1, detail: type === 'mousemove' ? 0 : 1};
    // Browsers fire the pointer event first; dispatch both so either kind of listener sees the drag.
    state.canvas.dispatchEvent(new PointerEvent(pointerType, {...init, pointerId: 1, pointerType: 'mouse', isPrimary: true}));
    state.canvas.dispatchEvent(new MouseEvent(type, init));
    markInput();
  }
  function wheel(x, y, deltaY) {
    state.canvas.dispatchEvent(new WheelEvent('wheel', {...canvasPoint(x, y), deltaY, deltaMode: 0, bubbles: true, cancelable: true, view: window}));
    markInput();
  }
  const touchSupported = (() => {
    try { new TouchEvent('touchstart'); new Touch({identifier: 0, target: document.documentElement}); return true; } catch { return false; }
  })();
  function touch(type, points) {
    const touches = points.map((pt, i) => new Touch({identifier: i + 1, target: state.canvas, ...canvasPoint(pt.x, pt.y)}));
    const list = type === 'touchend' ? [] : touches;
    state.canvas.dispatchEvent(new TouchEvent(type, {touches: list, targetTouches: list, changedTouches: touches, bubbles: true, cancelable: true, view: window}));
    markInput();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => nativeRaf(() => r()));

  /** Calls step(t, dt) at INPUT_HZ for `ms` milliseconds, t counting from 0. */
  async function drive(ms, step) {
    const start = now();
    let last = start;
    while (!aborted) {
      const t = now() - start;
      if (t >= ms) break;
      step(t, now() - last);
      last = now();
      await sleep(1000 / INPUT_HZ);
    }
  }

  /** Drags along path(t) -> {x, y} as one continuous drag. */
  async function drag(ms, path) {
    let p = path(0);
    mouse('mousedown', p.x, p.y);
    pointerDown = true;
    await drive(ms, (t) => { p = path(t); mouse('mousemove', p.x, p.y); });
    mouse('mouseup', p.x, p.y);
    pointerDown = false;
  }

  /** Repeated straight strokes, like a user dragging, lifting and dragging again. */
  async function strokes(ms, {length, strokeMs, gapMs, directions}) {
    const {w, h} = size();
    const start = now();
    for (let i = 0; !aborted && now() - start < ms; i++) {
      const angle = directions[i % directions.length] * Math.PI / 180;
      const dx = Math.cos(angle) * length, dy = Math.sin(angle) * length;
      const x0 = w / 2 - dx / 2, y0 = h / 2 - dy / 2;
      await drag(Math.min(strokeMs, ms - (now() - start)), (t) => ({x: x0 + dx * t / strokeMs, y: y0 + dy * t / strokeMs}));
      await sleep(gapMs);
    }
  }

  /**
   * Wheel events at `hz` at the canvas centre, flipping direction at the cellSize bounds. A bound of
   * 0 or Infinity means minCellSize/maxCellSize: reached when two redraws in a row show the same
   * cellSize although wheel events were sent in between (cellSize is only seen when the app draws).
   */
  async function wheelBetween(ms, {lo, hi, hz = INPUT_HZ}) {
    const {w, h} = size();
    let direction = 1; // 1 = zoom out (deltaY > 0)
    let seq = state.drawSeq, csAtSeq = state.cellSize, eventsSince = 0, clampedDraws = 0;
    const start = now();
    const interval = 1000 / hz;
    while (!aborted && now() - start < ms) {
      if (state.drawSeq !== seq) {
        if (eventsSince > 0) clampedDraws = state.cellSize === csAtSeq ? clampedDraws + 1 : 0;
        seq = state.drawSeq;
        csAtSeq = state.cellSize;
        eventsSince = 0;
      }
      const cs = state.cellSize;
      const flip = direction === 1 ? cs <= lo * 1.001 : cs >= hi * 0.999;
      if (flip || clampedDraws >= 2) { direction = -direction; clampedDraws = 0; }
      wheel(w / 2, h / 2, direction * 100);
      eventsSince++;
      await sleep(interval);
    }
  }

  function size() {
    return {w: state.canvas.clientWidth, h: Math.min(state.canvas.clientHeight, innerHeight)};
  }

  /** Zooms at the centre until cellSize is within 2.5% of target, or until it stops changing. */
  async function zoomTo(target) {
    const {w, h} = size();
    let unchanged = 0, previous = NaN;
    for (let i = 0; i < 400 && !aborted; i++) {
      const cs = state.cellSize;
      if (target !== 'min' && target !== 'max' && Math.abs(Math.log(cs / target)) < Math.log(1.025)) return;
      unchanged = cs === previous ? unchanged + 1 : 0;
      previous = cs;
      if (unchanged > 8) return; // clamped at minCellSize / maxCellSize
      const out = target === 'min' || (target !== 'max' && cs > target);
      wheel(w / 2, h / 2, out ? 100 : -100);
      await nextFrame();
      await nextFrame();
    }
  }

  /** Waits until the canvas is covered by blocks and a few ticks have been drawn. */
  async function settle(timeoutMs = 20000) {
    const start = now();
    let goodSince = null, drawsWhenGood = 0;
    while (!aborted && now() - start < timeoutMs) {
      await sleep(50);
      if (state.coverage >= 0.995) {
        if (goodSince === null) { goodSince = now(); drawsWhenGood = 0; }
        drawsWhenGood++;
        if (now() - goodSince > 800) return {settleMs: Math.round(now() - start), settled: true};
      } else {
        goodSince = null;
      }
    }
    return {settleMs: Math.round(now() - start), settled: false};
  }

  // ===================================================================================================
  // Scenarios. `zoom` is a cellSize, 'min', 'max', or a function of the device pixel scale.
  // The default set is the ones without `extra`; the extras run with --scenarios all or from the panel.
  // ===================================================================================================

  // The app pools blocks below 0.4 device pixels per cell; just above that, every block is a full
  // blockSize x blockSize bitmap while 25-40 of them are on screen: the largest bitmaps per frame.
  const pf1Edge = (scale) => 0.42 / scale;

  const scenarios = [
    {name: 'idle-min', extra: true, zoom: 'min', desc: 'minCellSize, no input: tick redraws only',
      run: (ms) => sleep(ms)},
    {name: 'pan-min-slow', extra: true, zoom: 'min', desc: 'minCellSize, drag back and forth ±200 px (≤ 320 px/s)',
      run: (ms) => { const {w, h} = size(); return drag(ms, (t) => ({x: w / 2 + 200 * Math.sin(2 * Math.PI * t / 4000), y: h / 2})); }},
    {name: 'pan-min-circle', zoom: 'min', desc: 'minCellSize, one continuous circular drag, r 250 px, 2 s per turn',
      run: (ms) => { const {w, h} = size(); return drag(ms, (t) => ({x: w / 2 + 250 * Math.cos(2 * Math.PI * t / 2000), y: h / 2 + 250 * Math.sin(2 * Math.PI * t / 2000)})); }},
    {name: 'pan-min-fast', zoom: 'min', desc: 'minCellSize, 800 px strokes at 1600 px/s, always westward: new blocks keep coming in',
      run: (ms) => strokes(ms, {length: 800, strokeMs: 500, gapMs: 60, directions: [0]})},
    {name: 'fling-min', extra: true, zoom: 'min', desc: 'minCellSize, 700 px flicks in 120 ms (~5800 px/s) in changing directions',
      run: (ms) => strokes(ms, {length: 700, strokeMs: 120, gapMs: 250, directions: [0, 135, 270, 45, 180, 315, 90, 225]})},
    {name: 'zoom-min-bounce', zoom: 'min', desc: 'wheel at 120 Hz between minCellSize and 0.4: crosses the poolFactor steps',
      run: (ms) => wheelBetween(ms, {lo: 0, hi: 0.4})},
    {name: 'zoom-rapid', zoom: 1, desc: 'wheel at 120 Hz between 0.12 and 2.5 at the centre',
      run: (ms) => wheelBetween(ms, {lo: 0.12, hi: 2.5})},
    {name: 'zoom-sweep', extra: true, zoom: 'min', desc: 'wheel at 120 Hz from minCellSize to maxCellSize and back',
      run: (ms) => wheelBetween(ms, {lo: 0, hi: Infinity})},
    {name: 'zoom-pan-min', extra: true, zoom: 'min', desc: 'circular drag while wheeling between minCellSize and 0.3 at 30 Hz',
      run: (ms) => {
        const {w, h} = size();
        return Promise.all([
          drag(ms, (t) => ({x: w / 2 + 250 * Math.cos(2 * Math.PI * t / 2000), y: h / 2 + 250 * Math.sin(2 * Math.PI * t / 2000)})),
          wheelBetween(ms, {lo: 0, hi: 0.3, hz: 30}),
        ]);
      }},
    {name: 'pinch-min', extra: true, zoom: 'min', desc: 'two-finger pinch at minCellSize, finger distance 150 ↔ 450 px, 1.2 s per cycle', touch: true,
      run: async (ms) => {
        const {w, h} = size();
        const at = (t) => {
          const d = 300 - 150 * Math.cos(2 * Math.PI * t / 1200);
          return [{x: w / 2 - d / 2, y: h / 2}, {x: w / 2 + d / 2, y: h / 2}];
        };
        touch('touchstart', at(0));
        await drive(ms, (t) => touch('touchmove', at(t)));
        touch('touchend', at(ms));
      }},
    {name: 'idle-pf1-edge', extra: true, zoom: pf1Edge, desc: '0.42 device px per cell (largest unpooled bitmaps), no input',
      run: (ms) => sleep(ms)},
    {name: 'pan-pf1-edge', zoom: pf1Edge, desc: '0.42 device px per cell, circular drag r 250 px',
      run: (ms) => { const {w, h} = size(); return drag(ms, (t) => ({x: w / 2 + 250 * Math.cos(2 * Math.PI * t / 2000), y: h / 2 + 250 * Math.sin(2 * Math.PI * t / 2000)})); }},
    {name: 'pan-close', extra: true, zoom: 4, desc: 'cellSize 4 (the default), circular drag r 250 px: 1-4 blocks, mostly off screen',
      run: (ms) => { const {w, h} = size(); return drag(ms, (t) => ({x: w / 2 + 250 * Math.cos(2 * Math.PI * t / 2000), y: h / 2 + 250 * Math.sin(2 * Math.PI * t / 2000)})); }},
  ];
  scenarios.sort((a, b) => Number(!!a.extra) - Number(!!b.extra));
  const scenarioByName = new Map(scenarios.map((s) => [s.name, s]));

  // ===================================================================================================
  // Summaries
  // ===================================================================================================

  const sorted = (a) => [...a].sort((x, y) => x - y);
  const pct = (a, p) => {
    if (!a.length) return null;
    const s = sorted(a);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const r1 = (x) => x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
  const r2 = (x) => x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
  const r3 = (x) => x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;

  function summarize(scenario, ms, extra) {
    const seconds = ms / 1000;
    const intervals = rec.frames.slice(1).map((t, i) => t - rec.frames[i]);
    const nominal = pct(intervals, 0.1) ?? 16.7; // ~ the display's refresh interval
    // Long frames by cause: the main-thread source that took most of the interval, if it took at least
    // a third of it; otherwise "other" (GPU/compositor back-pressure, GC, the browser's own work).
    const longBy = {ws: 0, draw: 0, commit: 0, other: 0};
    const excessBy = {ws: 0, draw: 0, commit: 0, other: 0};
    intervals.forEach((dt, i) => {
      if (dt <= 50) return;
      const w = rec.frameWork[i + 1];
      const parts = [['ws', w.ws], ['draw', w.app], ['commit', w.commit]].sort((a, b) => b[1] - a[1]);
      const cause = parts[0][1] >= dt / 3 ? parts[0][0] : 'other';
      longBy[cause]++;
      excessBy[cause] += dt - nominal;
    });
    const draws = rec.drawFrames;
    const payloadBatches = rec.batches.filter((b) => b.type === 'payload');
    const top = new Map();
    for (const l of rec.loaf) for (const s of l.scripts) top.set(s.invoker, (top.get(s.invoker) ?? 0) + s.ms);
    const scale = devicePixelScale();
    const bitmapWidths = sorted([...rec.bitmapWidths]);
    return {
      scenario: scenario.name,
      desc: scenario.desc,
      measuredMs: Math.round(ms),
      ...extra,
      env: {
        ua: navigator.userAgent, dpr: devicePixelRatio, canvasScale: r2(scale),
        canvas: state.canvas ? [state.canvas.width, state.canvas.height] : null,
        viewport: [innerWidth, innerHeight], blockSize: state.blockSize,
      },
      zoom: {
        cellSizeMin: r3(Math.min(...rec.cellSizes)), cellSizeMax: r3(Math.max(...rec.cellSizes)),
        cellSizeEnd: r3(state.cellSize),
        bitmapSizes: bitmapWidths.length > 6 ? [...bitmapWidths.slice(0, 3), '…', ...bitmapWidths.slice(-2)] : bitmapWidths,
      },
      frames: {
        count: rec.frames.length,
        fps: r1((rec.frames.length - 1) / ((rec.frames.at(-1) - rec.frames[0]) / 1000)),
        refreshMs: r1(nominal),
        p50: r1(pct(intervals, 0.5)), p95: r1(pct(intervals, 0.95)), p99: r1(pct(intervals, 0.99)), max: r1(pct(intervals, 1)),
        // A frame "drops" when it takes longer than 1.5 refresh intervals.
        dropped: intervals.filter((x) => x > nominal * 1.5).length,
        over50: intervals.filter((x) => x > 50).length,
        over100: intervals.filter((x) => x > 100).length,
        over50By: longBy,
        over50ExcessMsBy: Object.fromEntries(Object.entries(excessBy).map(([k, v]) => [k, Math.round(v)])),
      },
      main: {
        appRafP50: r2(pct(rec.appRaf, 0.5)), appRafP95: r2(pct(rec.appRaf, 0.95)), appRafMax: r2(pct(rec.appRaf, 1)),
        appRafTotalMs: Math.round(sum(rec.appRaf)),
        wsHandlerTotalMs: Math.round(sum(rec.wsMsgs.map((m) => m.handlerMs))),
        wsHandlerMax: r1(pct(rec.wsMsgs.map((m) => m.handlerMs), 1)),
        // Off the main thread: the socket handler in the socket worker, when the app has one.
        socketWorkerTotalMs: rec.socketMsgs.length ? Math.round(sum(rec.socketMsgs.map((m) => m.ms))) : null,
        socketWorkerMax: r1(pct(rec.socketMsgs.map((m) => m.ms), 1)),
        workerReplyTotalMs: Math.round(sum(rec.workerReplies.map((m) => m.handlerMs))),
        workerReplyMax: r1(pct(rec.workerReplies.map((m) => m.handlerMs), 1)),
      },
      draw: {
        framesDrawn: draws.length,
        // Time in the app's frame callbacks in frames where it drew: the main-thread cost of a redraw.
        appMsP50: r2(pct(draws.map((d) => d.app), 0.5)), appMsP95: r2(pct(draws.map((d) => d.app), 0.95)),
        appMsMax: r2(pct(draws.map((d) => d.app), 1)),
        drawsPerSec: r1(draws.length / seconds),
        callsP50: pct(draws.map((d) => d.calls), 0.5), callsMax: pct(draws.map((d) => d.calls), 1),
        canvasMsP50: r2(pct(draws.map((d) => d.canvasMs), 0.5)), canvasMsP95: r2(pct(draws.map((d) => d.canvasMs), 0.95)),
        canvasMsMax: r2(pct(draws.map((d) => d.canvasMs), 1)),
        srcMpxP50: r1(pct(draws.map((d) => d.srcPx), 0.5) / 1e6), srcMpxMax: r1(pct(draws.map((d) => d.srcPx), 1) / 1e6),
        // Pixels of bitmaps drawn for the first time: what a GPU canvas has to upload or import.
        newMpxPerSec: r1(sum(draws.map((d) => d.newPx)) / 1e6 / seconds),
        newMpxPerDrawMax: r1(pct(draws.map((d) => d.newPx), 1) / 1e6),
        canvasMpx: state.canvas ? r1(state.canvas.width * state.canvas.height / 1e6) : null,
      },
      coverage: {
        mean: r3(draws.length ? sum(draws.map((d) => d.cover)) / draws.length : null),
        min: r3(pct(draws.map((d) => d.cover), 0)),
        framesBelow98: draws.filter((d) => d.cover < 0.98).length,
      },
      net: {
        msgs: (rec.socketMsgs.length ? rec.socketMsgs : rec.wsMsgs).length,
        mbPerSec: r1(sum((rec.socketMsgs.length ? rec.socketMsgs : rec.wsMsgs).map((m) => m.bytes)) / 1e6 / seconds),
      },
      workers: {
        ticks: payloadBatches.length,
        rescales: rec.batches.filter((b) => b.type === 'rescale').length,
        tickLatencyP50: r1(pct(payloadBatches.map((b) => b.fromWs ?? b.latency), 0.5)),
        tickLatencyP95: r1(pct(payloadBatches.map((b) => b.fromWs ?? b.latency), 0.95)),
        bitmapsPerSec: r1(sum(rec.workerReplies.map((r) => r.bitmaps)) / seconds),
        createdMpxPerSec: r1(sum(rec.workerReplies.map((r) => r.px)) / 1e6 / seconds),
        liveBitmapMBPeak: Math.round(rec.liveBitmapPxPeak * 4 / 1e6),
      },
      latency: {
        tickToDrawP50: r1(pct(rec.drawToScreen, 0.5)), tickToDrawP95: r1(pct(rec.drawToScreen, 0.95)),
        inputToDrawP50: r1(pct(rec.inputLatency, 0.5)), inputToDrawP95: r1(pct(rec.inputLatency, 0.95)),
        inputToDrawMax: r1(pct(rec.inputLatency, 1)), inputEvents: rec.inputs,
      },
      loaf: loafSupported ? {
        count: rec.loaf.length,
        blockingMs: Math.round(sum(rec.loaf.map((l) => l.blocking))),
        maxMs: r1(pct(rec.loaf.map((l) => l.duration), 1)),
        renderMs: Math.round(sum(rec.loaf.map((l) => l.render))),
        forcedLayoutMs: Math.round(sum(rec.loaf.flatMap((l) => l.scripts.map((s) => s.layout)))),
        topScripts: [...top].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => [k, Math.round(v)]),
      } : null,
    };
  }

  // ===================================================================================================
  // Runner
  // ===================================================================================================

  let aborted = false;
  let running = null;

  async function waitForApp() {
    for (let i = 0; i < 400 && !state.canvas; i++) {
      state.canvas = document.querySelector('grid-view canvas') ?? document.querySelector('canvas');
      if (!state.canvas) await sleep(25);
    }
    if (!state.canvas) throw new Error('no canvas found');
    for (let i = 0; i < 600 && !Number.isFinite(state.cellSize); i++) await sleep(25);
    if (!Number.isFinite(state.cellSize)) throw new Error('the app never drew a block');
  }

  async function runScenario(name, ms) {
    const scenario = scenarioByName.get(name);
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    running = scenario.name;
    hud.status(`${name}: waiting for the app`);
    const info = await (await fetch('/__bench/info')).json();
    state.blockSize = info.blockSize;
    await waitForApp();
    if (scenario.touch && !touchSupported) {
      return {scenario: name, desc: scenario.desc, skipped: 'TouchEvent/Touch constructors not available in this browser'};
    }
    hud.status(`${name}: zooming`);
    const target = typeof scenario.zoom === 'function' ? scenario.zoom(devicePixelScale()) : scenario.zoom;
    await zoomTo(target);
    hud.status(`${name}: waiting for blocks`);
    const settled = await settle();
    await sleep(300);
    hud.status(`${name}: measuring`);
    rec.reset();
    rec.canvasPx = state.canvas.width * state.canvas.height;
    rec.on = true;
    const t0 = now();
    await scenario.run(ms);
    const measured = now() - t0;
    rec.on = false;
    if (pointerDown) mouse('mouseup', 0, 0);
    running = null;
    return summarize(scenario, measured, {settle: settled, tickMs: info.tickMs, commit: info.commit, dirty: info.dirty});
  }

  function browserName() {
    const ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Edg\//.test(ua)) return 'edge';
    if (/Chrome\//.test(ua)) return 'chrome';
    if (/Safari\//.test(ua)) return 'webkit';
    return 'browser';
  }

  async function postResult(runId, meta, result) {
    await fetch('/__bench/results', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({runId, meta, result})});
  }

  function readQueue() {
    try { return JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? 'null'); } catch { return null; }
  }
  function writeQueue(q) {
    try { q ? sessionStorage.setItem(QUEUE_KEY, JSON.stringify(q)) : sessionStorage.removeItem(QUEUE_KEY); } catch { /* ignore */ }
  }

  async function startRun(names, ms, label) {
    const info = await (await fetch('/__bench/info')).json();
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.slice(0, 19).replace(/[:T]/g, '-')}-${browserName()}${label ? '-' + label : ''}`;
    const meta = {runId, label, browser: browserName(), ua: navigator.userAgent, startedAt, commit: info.commit, dirty: info.dirty,
      durationMs: ms, tickMs: info.tickMs, blockSize: info.blockSize, density: info.density};
    writeQueue({runId, meta, ms, remaining: names});
    gotoNext();
  }

  function gotoNext() {
    const q = readQueue();
    if (!q) return;
    if (!q.remaining.length) {
      writeQueue(null);
      location.href = `/?bench=ui&run=${encodeURIComponent(q.runId)}`;
      return;
    }
    location.href = `/?bench=${encodeURIComponent(q.remaining[0])}&run=${encodeURIComponent(q.runId)}&duration=${q.ms}`;
  }

  async function onLoad() {
    hud.mount();
    fetch('/__bench/info').then((r) => r.json()).then((info) => { state.blockSize ||= info.blockSize; }).catch(() => {});
    const name = params.get('bench');
    const runId = params.get('run');
    if (!name || name === 'ui') {
      ui.open(runId);
      return;
    }
    const ms = Number(params.get('duration') ?? 4000);
    let result;
    try {
      result = await runScenario(name, ms);
    } catch (e) {
      result = {scenario: name, error: String(e?.stack ?? e)};
    }
    window.__benchResult = result;
    if (params.get('auto')) return;
    const q = readQueue();
    if (q && q.runId === runId) {
      await postResult(q.runId, q.meta, result);
      q.remaining = q.remaining.filter((s) => s !== name);
      writeQueue(q);
      if (!aborted) gotoNext();
      else { writeQueue(null); ui.open(q.runId); }
    } else {
      ui.open(null, [result]);
    }
  }

  // ===================================================================================================
  // HUD + panel (shadow DOM, so the app's styles and ours stay apart)
  // ===================================================================================================

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; top: 8px; left: 8px; z-index: 2147483647; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #e8e8e8; max-width: calc(100vw - 16px); }
    .hud { background: rgba(16,16,20,.86); border-radius: 6px; padding: 6px 8px; display: flex; gap: 12px; align-items: center;
      white-space: nowrap; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
    .hud b { color: #fff; font-weight: 600; }
    .hud .bad { color: #ff8a80; } .hud .ok { color: #9be39b; }
    .hud button { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 4px; background: #3a3f4b; color: #fff; }
    .hud button:hover { background: #4b5263; }
    .panel { margin-top: 6px; background: rgba(16,16,20,.94); border-radius: 6px; padding: 10px 12px; max-height: calc(100vh - 80px);
      overflow: auto; box-shadow: 0 2px 14px rgba(0,0,0,.4); max-width: min(1500px, calc(100vw - 16px)); }
    .panel[hidden] { display: none; }
    h3 { margin: 4px 0 6px; font-size: 12px; color: #aeb4c2; text-transform: uppercase; letter-spacing: .06em; }
    label { display: inline-flex; gap: 6px; align-items: center; margin: 2px 12px 2px 0; cursor: pointer; }
    .scen { columns: 2; column-gap: 24px; margin-bottom: 8px; }
    .scen label { display: flex; break-inside: avoid; }
    .scen small { color: #8b93a5; }
    input[type=number], input[type=text], select { background: #22252d; color: #eee; border: 1px solid #3a3f4b; border-radius: 4px; padding: 2px 6px; font: inherit; }
    input[type=number] { width: 70px; } input[type=text] { width: 120px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
    .row button { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 4px; background: #2f6fde; color: #fff; }
    .row button.sec { background: #3a3f4b; }
    table { border-collapse: collapse; margin-top: 6px; }
    th, td { padding: 2px 8px; text-align: right; border-bottom: 1px solid #2a2e37; white-space: nowrap; }
    th { color: #aeb4c2; font-weight: 500; position: sticky; top: -10px; background: #15161b; }
    td:first-child, th:first-child { text-align: left; }
    td .d { font-size: 10px; margin-left: 4px; }
    .better { color: #9be39b; } .worse { color: #ff8a80; } .muted { color: #8b93a5; }
    .note { color: #8b93a5; margin: 6px 0; max-width: 1100px; white-space: normal; }
  `;

  const hud = {
    root: null, el: null, lastUpdate: 0, statusText: '',
    mount() {
      if (this.root) return;
      const host = document.createElement('div');
      host.id = 'cellweb-bench';
      document.documentElement.appendChild(host);
      this.root = host.attachShadow({mode: 'open'});
      this.root.innerHTML = `<style>${css}</style><div class="wrap"><div class="hud"><span class="live"></span>
        <button class="toggle">bench</button></div><div class="panel" hidden></div></div>`;
      this.el = this.root.querySelector('.live');
      this.root.querySelector('.toggle').onclick = () => ui.toggle();
    },
    status(text) { this.statusText = text; this.lastUpdate = 0; },
    update() {
      if (!this.el) return;
      const t = now();
      if (t - this.lastUpdate < 250) return;
      this.lastUpdate = t;
      const frames = rec.frames;
      const recent = frames.slice(-30);
      const fps = recent.length > 1 ? (recent.length - 1) / ((recent.at(-1) - recent[0]) / 1000) : null;
      const cs = Number.isFinite(state.cellSize) ? state.cellSize.toFixed(3) : '-';
      const cover = (state.coverage * 100).toFixed(1);
      const live = Math.round(state.liveBitmapPx * 4 / 1e6);
      const fpsText = fps === null ? '-' : `<b class="${fps < 50 ? 'bad' : 'ok'}">${fps.toFixed(0)}</b>`;
      this.el.innerHTML = `${this.statusText ? `<b>${this.statusText}</b>` : 'idle'} · fps ${rec.on ? fpsText : '-'} · cellSize <b>${cs}</b>` +
        ` · cover <b class="${state.coverage < 0.98 ? 'bad' : ''}">${cover}%</b> · bitmaps <b>${state.liveBitmaps.size}</b> (${live} MB)`;
    },
  };

  // Columns of the results table: [label, path, digits, lower is better?]
  const columns = [
    ['fps', 'frames.fps', 0, false],
    ['frame p95', 'frames.p95', 1, true],
    ['frame max', 'frames.max', 0, true],
    ['dropped', 'frames.dropped', 0, true],
    ['>50ms', 'frames.over50', 0, true],
    ['…ws', 'frames.over50By.ws', 0, true],
    ['…draw', 'frames.over50By.draw', 0, true],
    ['…other', 'frames.over50By.other', 0, true],
    ['draw ms p95', 'draw.appMsP95', 2, true],
    ['canvas ms p95', 'draw.canvasMsP95', 2, true],
    ['draws/s', 'draw.drawsPerSec', 0, null],
    ['src Mpx/draw', 'draw.srcMpxP50', 1, true],
    ['new Mpx/s', 'draw.newMpxPerSec', 0, true],
    ['live MB', 'workers.liveBitmapMBPeak', 0, true],
    ['cover min', 'coverage.min', 3, false],
    ['ws ms', 'main.wsHandlerTotalMs', 0, true],
    ['socket wkr ms', 'main.socketWorkerTotalMs', 0, true],
    ['commit ms', 'main.workerReplyTotalMs', 0, true],
    ['tick→draw p95', 'latency.tickToDrawP95', 0, true],
    ['input→draw p95', 'latency.inputToDrawP95', 1, true],
    ['LoAF block ms', 'loaf.blockingMs', 0, true],
  ];
  const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

  function tableHtml(results, baseline) {
    const base = new Map((baseline?.results ?? []).map((r) => [r.scenario, r]));
    const head = `<tr><th>scenario</th><th>cellSize</th>${columns.map((c) => `<th>${c[0]}</th>`).join('')}</tr>`;
    const rows = results.map((r) => {
      if (r.error || r.skipped) return `<tr><td>${r.scenario}</td><td colspan="${columns.length + 1}" class="muted" style="text-align:left">${r.skipped ?? r.error}</td></tr>`;
      const b = base.get(r.scenario);
      const cs = r.zoom.cellSizeMin === r.zoom.cellSizeMax ? `${r.zoom.cellSizeMin}` : `${r.zoom.cellSizeMin}–${r.zoom.cellSizeMax}`;
      const cells = columns.map(([, path, digits, lowerBetter]) => {
        const v = get(r, path);
        if (v == null) return '<td class="muted">–</td>';
        let delta = '';
        const bv = b ? get(b, path) : null;
        if (bv != null && lowerBetter !== null && bv !== v) {
          const better = lowerBetter ? v < bv : v > bv;
          const rel = bv === 0 ? '' : ` ${v > bv ? '+' : ''}${Math.round((v - bv) / Math.abs(bv) * 100)}%`;
          delta = `<span class="d ${better ? 'better' : 'worse'}">${rel || (v > bv ? '↑' : '↓')}</span>`;
        }
        return `<td>${Number(v).toFixed(digits)}${delta}</td>`;
      }).join('');
      return `<tr title="${r.desc ?? ''}"><td>${r.scenario}${r.settle && !r.settle.settled ? ' <span class="worse" title="blocks never covered the screen before measuring">*</span>' : ''}</td><td>${cs}</td>${cells}</tr>`;
    }).join('');
    return `<table>${head}${rows}</table>`;
  }

  const ui = {
    panel: null,
    toggle() {
      if (!this.panel) this.open(null);
      else this.panel.hidden = !this.panel.hidden;
    },
    async open(runId, localResults) {
      hud.mount();
      this.panel = hud.root.querySelector('.panel');
      this.panel.hidden = false;
      const runs = await (await fetch('/__bench/runs')).json().catch(() => []);
      let baselineId = null;
      try { baselineId = localStorage.getItem(BASELINE_KEY); } catch { /* ignore */ }
      const current = runId ? await (await fetch(`/__bench/runs/${encodeURIComponent(runId)}`)).json().catch(() => null) : null;
      const baseline = baselineId && baselineId !== runId ? await (await fetch(`/__bench/runs/${encodeURIComponent(baselineId)}`)).json().catch(() => null) : null;
      const results = localResults ?? current?.results ?? [];
      const runOptions = runs.map((r) => `<option value="${r.runId}" ${r.runId === runId ? 'selected' : ''}>${r.runId} (${r.scenarios}, ${r.meta?.commit ?? ''}${r.meta?.dirty?.length ? '+dirty' : ''})</option>`).join('');
      const baseOptions = `<option value="">no baseline</option>` + runs.map((r) => `<option value="${r.runId}" ${r.runId === baselineId ? 'selected' : ''}>${r.runId}</option>`).join('');
      this.panel.innerHTML = `
        <h3>Scenarios</h3>
        <div class="scen">${scenarios.map((s) => `<label><input type="checkbox" value="${s.name}" ${s.extra ? '' : 'checked'}> <span>${s.name}${s.extra ? ' <small>(extra)</small>' : ''}<br><small>${s.desc}</small></span></label>`).join('')}</div>
        <div class="row">
          <label>seconds <input type="number" class="dur" value="${(Number(params.get('duration') ?? 4000) / 1000)}" min="1" max="120"></label>
          <label>label <input type="text" class="label" placeholder="e.g. baseline"></label>
          <button class="run">Run selected</button>
          <button class="sec none">none</button><button class="sec core">default</button><button class="sec all">all</button>
          ${running ? '<button class="sec stop">stop</button>' : ''}
        </div>
        <div class="note">Each scenario runs on a fresh page load against the mock backend (tick ${current?.meta?.tickMs ?? ''} ms). Keep this window visible
          while it runs: hidden or occluded windows throttle requestAnimationFrame. Results land in bench/results/.</div>
        <h3>Results</h3>
        <div class="row">
          <label>run <select class="runs"><option value="">–</option>${runOptions}</select></label>
          <label>compare with <select class="base">${baseOptions}</select></label>
          ${runId ? `<button class="sec setbase">use this run as baseline</button>` : ''}
        </div>
        ${current ? `<div class="note">${current.meta.browser} · commit ${current.meta.commit}${current.meta.dirty?.length ? ' + uncommitted: ' + current.meta.dirty.join(', ') : ''} · ${current.meta.durationMs / 1000} s per scenario${baseline ? ` · deltas vs ${baseline.runId}` : ''}</div>` : ''}
        ${results.length ? tableHtml(results, baseline) : '<div class="note">No results yet.</div>'}
        <div class="note">fps / frame p95 / max / dropped (> 1.5 refresh intervals) / >50ms come from requestAnimationFrame on the main thread.
          …ws / …draw / …other split the >50ms frames by what took most of them: the STOMP handler, the app's frame callback
          (drawing), or nothing measurable on the main thread (GPU/compositor back-pressure, GC).
          draw ms = time in the app's frame callback in frames where it drew; canvas ms = the part of that inside canvas calls
          (GPU work is not included and shows up as longer frames or as …other).
          src Mpx/draw = bitmap pixels drawn per redraw; new Mpx/s = pixels of bitmaps drawn for the first time (what the canvas uploads or imports).
          live MB = peak bytes of ImageBitmaps held. ws ms / commit ms = main-thread time handling socket messages and worker replies;
          socket wkr ms = time in the socket handler inside the socket worker (off the main thread).
          tick→draw = socket message to first draw of its bitmaps. LoAF = Long Animation Frames (Chromium only). Hover a row for its description.</div>`;
      const $ = (s) => this.panel.querySelector(s);
      $('.run').onclick = () => {
        const names = [...this.panel.querySelectorAll('.scen input:checked')].map((i) => i.value);
        if (names.length) startRun(names, Math.round(Number($('.dur').value) * 1000), $('.label').value.trim().replace(/\W+/g, '-'));
      };
      $('.none').onclick = () => this.panel.querySelectorAll('.scen input').forEach((i) => { i.checked = false; });
      $('.all').onclick = () => this.panel.querySelectorAll('.scen input').forEach((i) => { i.checked = true; });
      $('.core').onclick = () => this.panel.querySelectorAll('.scen input').forEach((i) => { i.checked = !scenarioByName.get(i.value).extra; });
      if ($('.stop')) $('.stop').onclick = () => { aborted = true; };
      $('.runs').onchange = (e) => { location.href = `/?bench=ui&run=${encodeURIComponent(e.target.value)}`; };
      $('.base').onchange = (e) => {
        try { e.target.value ? localStorage.setItem(BASELINE_KEY, e.target.value) : localStorage.removeItem(BASELINE_KEY); } catch { /* ignore */ }
        this.open(runId, localResults);
      };
      if ($('.setbase')) $('.setbase').onclick = () => {
        try { localStorage.setItem(BASELINE_KEY, runId); } catch { /* ignore */ }
        this.open(runId, localResults);
      };
    },
  };

  window.__bench = {scenarios: scenarios.map((s) => ({name: s.name, desc: s.desc, extra: !!s.extra})), runScenario, state, rec};

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onLoad);
  else onLoad();
})();
