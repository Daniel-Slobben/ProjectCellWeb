// Serves the production build of CellWeb against a mock backend, with the drawing bench injected.
//
//   node bench/server.mjs [--port 4300] [--tick 250] [--dist <build>/browser]
//                         [--pattern recorded|noise|lines] [--recording bench/recordings/world.bin] [--block-size 2000] [--density 0.1667]
//
// --dist serves another build of the app, e.g. one made with `npx ng build --output-path /tmp/variant`,
// so two versions of the drawing code can be compared against the same mock.
//
// The mock speaks the same wire protocol as the Spring backend: GET /gen-api/settings and STOMP over a
// raw WebSocket at /ws, where each connection is one client that subscribes to /user/queue/blocks. Like
// the backend, it answers every /client-update, the range of blocks in view, with one MESSAGE per block new in view
// holding its FULL, and
// every tick sends each client one MESSAGE with a BORDER for each block it already has (an empty one if
// it has none). A client that watches sectors gets no FULLs or BORDERs, but the SECTORs of the blocks in view in
// messages of 250: those new in view with each /client-update, and all of them every 10 s. Block messages are binary frames (application/octet-stream) in the layout of
// src/app/features/world-of-cells/grid-view/block-frame.ts. Every block exists, so it never sends
// NO_BLOCKS, and it has no heartbeats: --pattern lines sends nothing per tick.
// The cells are a recording of world-of-cells.net by record.mjs: each block a client adds gets a recorded FULL, then
// the recorded BORDERs that followed it, from the start again once they run out. The recorded rectangle of blocks
// repeats across the world, and blocks that didn't exist there are filled with ones that did. The settings send the
// recorded viewport and blockSize. SECTORs aren't recorded: they're random at --density. --pattern noise serves random
// cells at --density and --block-size instead.
// --pattern lines serves alternating alive/dead lines, vertical and horizontal in a checkerboard of blocks, and
// sends no BORDERs: the lines are a still life, so the blocks stay as they are.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execSync} from 'node:child_process';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(benchDir, '..');
const defaultDist = path.join(projectDir, 'dist/CellWeb/browser');
const clientDir = path.join(benchDir, 'client');
const resultsDir = path.join(benchDir, 'results');

export function parseArgs(argv, defaults) {
  const out = {...defaults};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const key = m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
    let value = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    if (typeof defaults[key] === 'number') value = Number(value);
    if (typeof defaults[key] === 'boolean') value = value !== 'false';
    out[key] = value;
  }
  return out;
}

export const serverDefaults = {port: 4300, tick: 250, blockSize: 2000, density: 1 / 6, dist: '', quiet: false, pattern: 'recorded',
  recording: path.join(benchDir, 'recordings/world.bin')};

// --- payloads: zstd frames at level 3 like the backend's, FULL as runs of strips (readStrips in block-frame.ts) ---

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBits(nBits, density, rnd) {
  const out = new Uint8Array(Math.ceil(nBits / 8));
  for (let i = 0; i < nBits; i++) if (rnd() < density) out[i >>> 3] |= 1 << (i & 7);
  return out;
}

function compress(raw) {
  return zlib.zstdCompressSync(raw, {params: {[zlib.constants.ZSTD_c_compressionLevel]: 3}});
}

// Cell by cell, so it reads plainly rather than fast: the strips, then a zero for no copied rows and per run of live
// bytes down a strip a varint of the empty bytes before it, its bytes and a zero.
function fullPayload(raw, blockSize) {
  const columns = Math.ceil(blockSize / 8), strips = new Uint8Array(Math.ceil(blockSize / 64) * 64 * columns);
  for (let x = 0; x < blockSize; x++) {
    for (let y = 0; y < blockSize; y++) {
      const cell = x * blockSize + y;
      if ((raw[cell >>> 3] >> (cell & 7)) & 1) strips[((x >> 6) * columns + (y >> 3)) * 64 + (x & 63)] |= 1 << (y & 7);
    }
  }
  const runs = [0];
  for (let i = 0, end = 0; i < strips.length;) {
    if (!strips[i]) { i++; continue; }
    let gap = i - end;
    for (; gap >= 0x80; gap >>>= 7) runs.push((gap & 0x7f) | 0x80);
    runs.push(gap);
    do runs.push(strips[i++]); while (i % 64 && strips[i]);
    runs.push(0);
    end = i;
  }
  return compress(Uint8Array.from(runs));
}

// The share of alive cells per sector of 50 by 50 cells as a u8 of 0-255, between none and twice the density.
function sectorPayload(blockSize, density, rnd) {
  const sectors = blockSize / 50;
  return compress(new Uint8Array(sectors * sectors).map(() => Math.ceil(255 * Math.min(1, density * 2 * rnd()))));
}

// Cells are column-major (bit x * blockSize + y): 0xff fills even columns, 0x55 even rows.
function linePayloads(blockSize) {
  const vertical = new Uint8Array(blockSize * blockSize / 8);
  for (let x = 0; x < blockSize; x += 2) vertical.fill(0xff, x * blockSize / 8, (x + 1) * blockSize / 8);
  const horizontal = new Uint8Array(blockSize * blockSize / 8).fill(0x55);
  return {full: [fullPayload(vertical, blockSize), fullPayload(horizontal, blockSize)], border: [], sector: [sectorPayload(blockSize, 0.5, () => 0.5)]};
}

function makePayloads(blockSize, density) {
  const rnd = mulberry32(1234);
  const full = [], border = [], sector = [];
  for (let i = 0; i < 8; i++) full.push(fullPayload(randomBits(blockSize * blockSize, density, rnd), blockSize));
  for (let i = 0; i < 16; i++) border.push(compress(randomBits(blockSize * 4 - 4, density, rnd)));
  for (let i = 0; i < 8; i++) sector.push(sectorPayload(blockSize, density, rnd));
  return {full, border, sector};
}

// The JSON line and blocks record.mjs writes. A world block is the recorded block at the same place in the rectangle
// they span, or another one where that block didn't exist.
function readRecording(file) {
  const data = fs.readFileSync(file);
  const newline = data.indexOf('\n');
  const blocks = new Map();
  for (let i = newline + 1; i < data.length;) {
    const x = data.readInt32LE(i), y = data.readInt32LE(i + 4), end = i + 17 + data.readUInt32LE(i + 13);
    const cells = data.subarray(i + 17, end);
    if (data[i + 8] === 0) blocks.set(`${x}/${y}`, {full: cells, borders: []});
    else blocks.get(`${x}/${y}`).borders.push(cells);
    i = end;
  }
  const xs = [...blocks.keys()].map((k) => Number(k.split('/')[0])), ys = [...blocks.keys()].map((k) => Number(k.split('/')[1]));
  const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left + 1, height = Math.max(...ys) - top + 1;
  const all = [...blocks.values()];
  const mod = (a, n) => ((a % n) + n) % n;
  return {
    ...JSON.parse(data.toString('utf8', 0, newline)), blocks: all,
    at: (x, y) => blocks.get(`${left + mod(x - left, width)}/${top + mod(y - top, height)}`) ?? all[mod(x * 31 + y * 17, all.length)],
  };
}

// --- minimal RFC 6455 server side: text frames, ping, close; no extensions ---

function encodeFrame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return [head, payload];
}

class WsConnection {
  constructor(socket, onText, onClose) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain(onText);
    });
    const close = () => {
      if (this.closed) return;
      this.closed = true;
      onClose();
    };
    socket.on('close', close);
    socket.on('error', close);
  }

  drain(onText) {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, offset = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (b.length < offset + len) return;
      const payload = Buffer.from(b.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskOffset + (i & 3)];
      this.buffer = b.subarray(offset + len);

      if (opcode === 0x8) { this.send(0x8, Buffer.alloc(0)); this.socket.end(); return; }
      if (opcode === 0x9) { this.send(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      this.fragments.push(payload);
      if (fin) {
        const message = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        onText(message);
      }
    }
  }

  send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    for (const part of encodeFrame(opcode, payload)) this.socket.write(part);
  }

  sendText(text) { this.send(0x1, Buffer.from(text, 'utf8')); }
}

// --- STOMP, framed like Spring's StompEncoder (it sends content-length) ---

function parseStompFrames(text) {
  const frames = [];
  for (const raw of text.split('\0')) {
    const trimmed = raw.replace(/^[\r\n]+/, '');
    if (!trimmed) continue;
    const split = trimmed.indexOf('\n\n');
    const head = (split < 0 ? trimmed : trimmed.slice(0, split)).split('\n');
    const headers = {};
    for (const line of head.slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0 && !(line.slice(0, colon) in headers)) headers[line.slice(0, colon)] = line.slice(colon + 1);
    }
    frames.push({command: head[0].trim(), headers, body: split < 0 ? '' : trimmed.slice(split + 2)});
  }
  return frames;
}

/** A MESSAGE with a binary body, sent as a binary WebSocket frame like Spring does for byte[] payloads. */
function stompBinaryFrame(headers, body) {
  const lines = ['MESSAGE'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}:${v}`);
  lines.push(`content-length:${body.length}`);
  return Buffer.concat([Buffer.from(lines.join('\n') + '\n\n'), body, Buffer.from([0])]);
}

function stompFrame(command, headers, body = '') {
  const lines = [command];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}:${v}`);
  if (body) lines.push(`content-length:${Buffer.byteLength(body)}`);
  return lines.join('\n') + '\n\n' + body + '\0';
}

// --- the mock backend ---

function gitInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', {cwd: projectDir}).toString().trim();
    const dirty = execSync('git status --porcelain -- src', {cwd: projectDir}).toString().trim();
    return {commit, dirty: dirty ? dirty.split('\n').map((l) => l.slice(3)) : []};
  } catch {
    return {commit: 'unknown', dirty: []};
  }
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

export async function startServer(options = {}) {
  const opts = {...serverDefaults, ...options};
  const log = opts.quiet ? () => {} : (...a) => console.log('[bench-server]', ...a);
  const distDir = opts.dist ? path.resolve(opts.dist) : defaultDist;
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`No build at ${path.relative(projectDir, distDir)}. Run "npx ng build" first.`);
  }
  const t0 = Date.now();
  const recording = opts.pattern === 'recorded' ? readRecording(opts.recording) : null;
  const blockSize = recording?.blockSize ?? opts.blockSize;
  const payloads = recording ? {sector: Array.from({length: 8}, (_, i) => sectorPayload(blockSize, opts.density, mulberry32(i)))}
    : opts.pattern === 'lines' ? linePayloads(blockSize) : makePayloads(blockSize, opts.density);
  const kb = (bytes) => Math.round(bytes / 1024 * 10) / 10;
  if (recording) {
    const fulls = recording.blocks.map((b) => b.full.length), borders = recording.blocks.flatMap((b) => b.borders.map((c) => c.length));
    log(`recording of ${recording.url} at ${recording.recordedAt}: ${fulls.length} blocks of ${blockSize}, ` +
      `FULL ~${kb(fulls.reduce((a, b) => a + b) / fulls.length)} KB, BORDER ~${kb(borders.reduce((a, b) => a + b) / borders.length)} KB of zstd, ` +
      `${Math.min(...recording.blocks.map((b) => b.borders.length))} generations`);
  } else {
    log(`payloads for blockSize ${blockSize}, density ${opts.density.toFixed(3)}: FULL ~${kb(payloads.full[0].length)} KB, ` +
      `BORDER ~${kb(payloads.border[0]?.length ?? 0)} KB of zstd (${Date.now() - t0} ms)`);
  }

  // Start where the recording was made, or a quarter into a block far from the origin.
  const home = recording?.viewport ?? {x: 50 * blockSize + blockSize / 4, y: 50 * blockSize + blockSize / 4};
  let worldGeneration = 0, ticks = 0;
  const clients = new Set(); // {id, keys: Set, sent: Map of key to the generation of its FULL, connection, subscription, messageId}

  const cellsFor = (x, y, type, age) => {
    if (recording && type !== 'SECTOR') {
      const block = recording.at(x, y);
      return type === 'FULL' ? block.full : block.borders[(age - 1) % block.borders.length];
    }
    // With two line payloads this picks them in a checkerboard: x * 31 + y * 17 has the parity of x + y.
    const pool = payloads[type.toLowerCase()];
    return pool[Math.abs(x * 31 + y * 17 + worldGeneration) % pool.length];
  };
  const typeCodes = {FULL: 0, BORDER: 1, SECTOR: 2};
  const sendBlocks = (client, keys, type) => {
    const parts = [];
    for (const key of keys) {
      const [x, y] = key.split('/').map(Number);
      const cells = cellsFor(x, y, type, worldGeneration - client.sent.get(key));
      const head = Buffer.alloc(17);
      head.writeInt32LE(x, 0);
      head.writeInt32LE(y, 4);
      head.writeUInt8(typeCodes[type], 8);
      head.writeUInt32LE(worldGeneration, 9);
      head.writeUInt32LE(cells.length, 13);
      parts.push(head, cells);
    }
    client.connection.send(0x2, stompBinaryFrame({
      destination: '/user/queue/blocks', 'content-type': 'application/octet-stream',
      subscription: client.subscription, 'message-id': `${client.id}-${client.messageId++}`,
    }, Buffer.concat(parts)));
  };
  const ready = (client) => client.subscription !== null;
  /** One message per FULL for every subscribed block the client has not had yet. */
  const sendFulls = (client) => {
    if (!ready(client)) return;
    const unsent = [...client.keys].filter((key) => !client.sent.has(key));
    for (const key of unsent) client.sent.set(key, worldGeneration);
    for (const key of unsent) sendBlocks(client, [key], 'FULL');
  };
  const keysIn = (view) => {
    const keys = [];
    for (let x = view.minX; x <= view.maxX; x++) for (let y = view.minY; y <= view.maxY; y++) keys.push(`${x}/${y}`);
    return keys;
  };
  const inView = (view, key) => {
    const [x, y] = key.split('/').map(Number);
    return x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  };
  const sendSectors = (client, keys) => {
    if (!ready(client)) return;
    for (let i = 0; i < keys.length; i += 250) sendBlocks(client, keys.slice(i, i + 250), 'SECTOR');
  };
  const ticksPer = (ms) => Math.max(1, Math.floor(ms / opts.tick));

  const tick = () => {
    if (opts.pattern !== 'lines') worldGeneration++;
    const t = ticks++;
    const sectorTick = t % ticksPer(10000) === 0;
    for (const client of clients) {
      if (!ready(client)) continue;
      if (client.sectors) {
        if (sectorTick && client.view) sendSectors(client, keysIn(client.view));
        continue;
      }
      if (opts.pattern !== 'lines') sendBlocks(client, [...client.sent.keys()], 'BORDER');
      // Only blocks added before the subscription existed are still waiting for their FULL.
      sendFulls(client);
    }
  };
  const ticker = setInterval(tick, opts.tick);
  let connectionCount = 0;

  const onStomp = (client) => (text) => {
    for (const frame of parseStompFrames(text)) {
      switch (frame.command) {
        case 'CONNECT':
        case 'STOMP':
          client.connection.sendText(stompFrame('CONNECTED', {version: '1.2', 'heart-beat': '0,0', server: 'cellweb-bench'}));
          break;
        case 'SUBSCRIBE':
          if (frame.headers.destination === '/user/queue/blocks') client.subscription = frame.headers.id;
          break;
        case 'UNSUBSCRIBE':
          if (client.subscription === frame.headers.id) client.subscription = null;
          break;
        case 'SEND': {
          if (frame.headers.destination === '/client-update') {
            const update = JSON.parse(frame.body);
            const view = {minX: update.minX, maxX: update.maxX, minY: update.minY, maxY: update.maxY};
            const old = client.view, switched = !!update.sectors !== client.sectors;
            client.view = view;
            client.sectors = !!update.sectors;
            if (client.sectors) {
              client.keys.clear();
              client.sent.clear();
              sendSectors(client, keysIn(view).filter((key) => switched || !old || !inView(old, key)));
              break;
            }
            const keys = new Set(keysIn(view));
            for (const key of client.keys) if (!keys.has(key)) { client.keys.delete(key); client.sent.delete(key); }
            for (const key of keys) client.keys.add(key);
            // The client's error path asks for a fresh FULL.
            for (const key of update.resend ?? []) if (keys.has(key)) client.sent.delete(key);
            sendFulls(client);
          }
          break;
        }
        case 'DISCONNECT':
          if (frame.headers.receipt) client.connection.sendText(stompFrame('RECEIPT', {'receipt-id': frame.headers.receipt}));
          break;
      }
    }
  };

  const sendJson = (res, status, body) => {
    res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const runFile = (runId) => path.join(resultsDir, `${runId.replace(/[^\w.-]/g, '_')}.json`);

  const server = http.createServer(async (req, res) => {
    // Cross-origin isolation gives performance.now() 5-20 us resolution instead of 100 us - 1 ms.
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-embedder-policy', 'require-corp');
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/gen-api/settings') {
      return sendJson(res, 200, {blockSize, viewport: home, targetSpeed: opts.tick});
    }
    if (p === '/__bench/info') {
      return sendJson(res, 200, {blockSize, tickMs: opts.tick, pattern: recording ? `recorded ${recording.recordedAt}` : opts.pattern,
        density: recording ? null : opts.density, home,
        dist: path.relative(projectDir, distDir) || '.', ...gitInfo()});
    }
    if (p === '/__bench/results' && req.method === 'POST') {
      const {runId, meta, result} = JSON.parse(await readBody(req));
      fs.mkdirSync(resultsDir, {recursive: true});
      const file = runFile(runId);
      const run = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {runId, meta, results: []};
      run.results = run.results.filter((r) => r.scenario !== result.scenario).concat(result);
      fs.writeFileSync(file, JSON.stringify(run, null, 1));
      return sendJson(res, 200, {ok: true});
    }
    if (p === '/__bench/runs') {
      const runs = !fs.existsSync(resultsDir) ? [] : fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json')).map((f) => {
        try {
          const run = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
          return {runId: run.runId, meta: run.meta, scenarios: run.results.length};
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => (b.meta?.startedAt ?? '').localeCompare(a.meta?.startedAt ?? ''));
      return sendJson(res, 200, runs);
    }
    if (p.startsWith('/__bench/runs/')) {
      const file = runFile(decodeURIComponent(p.slice('/__bench/runs/'.length)));
      return fs.existsSync(file) ? sendJson(res, 200, JSON.parse(fs.readFileSync(file, 'utf8'))) : sendJson(res, 404, {});
    }

    let file;
    if (p.startsWith('/__bench/')) file = path.join(clientDir, p.slice('/__bench/'.length));
    else file = path.join(distDir, p);
    if (!file.startsWith(clientDir) && !file.startsWith(distDir)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html');

    const headers = {'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'};
    if (file.startsWith(distDir) && /^worker-[^/]*\.js$/.test(path.basename(file))) {
      // Workers get the bench's socket hook too: the STOMP client runs in one of them.
      res.writeHead(200, headers);
      return res.end(fs.readFileSync(path.join(clientDir, 'worker-hook.js'), 'utf8') + fs.readFileSync(file, 'utf8'));
    }
    if (file === path.join(distDir, 'index.html')) {
      // The bench must run before the app bundle so its hooks see every canvas call, worker and socket.
      const html = fs.readFileSync(file, 'utf8').replace('<head>', '<head>\n  <script src="/__bench/bench.js"></script>');
      res.writeHead(200, headers);
      return res.end(html);
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });

  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    const protocol = ['v12.stomp', 'v11.stomp', 'v10.stomp'].find((v) => offered.includes(v));
    socket.setNoDelay(true);
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
    const client = {id: ++connectionCount, keys: new Set(), sent: new Map(), view: null, sectors: false, connection: null, subscription: null, messageId: 0};
    client.connection = new WsConnection(socket, onStomp(client), () => clients.delete(client));
    clients.add(client);
  });

  await new Promise((resolve) => server.listen(opts.port, resolve));
  const port = server.address().port;
  log(`CellWeb + mock backend + bench at http://localhost:${port}/ (tick ${opts.tick} ms)`);
  return {
    port,
    url: `http://localhost:${port}/`,
    close: () => new Promise((resolve) => {
      clearInterval(ticker);
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2), serverDefaults);
  const {url} = await startServer(opts);
  console.log(`Open ${url} in any browser; the bench panel is in the top-left corner.`);
}
