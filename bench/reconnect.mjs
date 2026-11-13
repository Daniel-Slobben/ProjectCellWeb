// Reconnect bench: the production build against the real backend on :8080, through a proxy that can
// break the /ws socket. Measures the time from "wake" to the first freshly decoded block bitmap.
//
//   npx ng build && node bench/reconnect.mjs [--scenarios kill,halfopen,...] [--headed] [--runs 1]
//
// Scenarios:
//   kill            the socket is closed (FIN), as when the OS kills it during standby
//   halfopen        the socket silently stops passing data in both directions and never closes
//   sleep<N>-<mode> the page's main thread is frozen for N s and reported hidden, while the socket is
//                   killed or goes half-open; the clock starts when the page wakes and is visible again
//   hidden<N>       the page is reported hidden for N s and nothing breaks; past 10 s it lets go of its
//                   socket, so the clock (from visible again) shows what coming back to a tab costs
//   pan<N>k         nothing breaks; server-to-client traffic is throttled to N kbit/s while the page pans
//                   at the smallest zoom, so new blocks keep arriving. Any reconnect here is a false alarm
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {parseArgs} from './server.mjs';

const opts = parseArgs(process.argv.slice(2), {
  scenarios: 'kill,halfopen,sleep3-halfopen,sleep8-halfopen,sleep20-halfopen,sleep30-halfopen,sleep30-kill,hidden5,hidden15',
  backend: 8080, dist: 'dist/CellWeb/browser', headed: false, runs: 1, timeout: 25000,
});
const dist = path.resolve(opts.dist);
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff'};

const sockets = new Set();
let kbps = 0;
// Server-to-client WebSocket messages as they complete: [time, bytes]
let messages = [];
let rawBytes = 0;

// Splits the unmasked server-to-client byte stream into frames and records each final frame.
function frameReader() {
  let buffer = Buffer.alloc(0);
  let remaining = 0;
  let size = 0;
  let fin = false;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (remaining > 0) {
        const take = Math.min(remaining, buffer.length);
        remaining -= take;
        buffer = buffer.subarray(take);
        if (remaining > 0) return;
        if (fin) {
          messages.push([Date.now(), size]);
          size = 0;
        }
        continue;
      }
      if (buffer.length < 2) return;
      let len = buffer[1] & 0x7f;
      let header = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        header = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        header = 10;
      }
      fin = (buffer[0] & 0x80) !== 0;
      size += len;
      buffer = buffer.subarray(header);
      remaining = len;
      if (len === 0 && fin) {
        messages.push([Date.now(), size]);
        size = 0;
      }
    }
  };
}
let log = [];
const mark = (what) => log.push({t: Date.now(), what});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__sleep') {
    setTimeout(() => res.end('ok'), Number(url.searchParams.get('ms')));
    return;
  }
  if (url.pathname.startsWith('/gen-api/')) {
    mark(`http ${url.pathname}`);
    const upstream = http.request({port: opts.backend, path: req.url, method: req.method, headers: req.headers}, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
    return;
  }
  let file = path.join(dist, url.pathname);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});

server.on('upgrade', (req, client, head) => {
  const upstream = net.connect(opts.backend, 'localhost');
  const conn = {client, upstream, halfOpen: false};
  sockets.add(conn);
  mark('ws open');
  const headers = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
  upstream.write(head);
  let handshakeDone = false;
  const readFrames = frameReader();
  client.on('data', (d) => conn.halfOpen || upstream.write(d));
  upstream.on('data', (d) => {
    if (conn.halfOpen) return;
    client.write(d);
    if (!handshakeDone) {
      const end = d.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshakeDone = true;
      d = d.subarray(end + 4);
    }
    readFrames(d);
    rawBytes += d.length;
    if (kbps > 0) {
      upstream.pause();
      setTimeout(() => upstream.resume(), (d.length * 8) / kbps);
    }
  });
  const close = () => {
    if (!sockets.delete(conn)) return;
    mark('ws closed');
    client.destroy();
    upstream.destroy();
  };
  client.on('close', close);
  upstream.on('close', close);
  client.on('error', close);
  upstream.on('error', close);
});

function breakSockets(mode) {
  for (const conn of sockets) {
    if (mode === 'kill') {
      conn.client.destroy();
      conn.upstream.destroy();
    } else {
      conn.halfOpen = true;
    }
  }
}

await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const initScript = () => {
  window.__bitmaps = [];
  window.__connected = [];
  window.__hidden = false;
  Object.defineProperty(Document.prototype, 'visibilityState', {get: () => (window.__hidden ? 'hidden' : 'visible')});
  Object.defineProperty(Document.prototype, 'hidden', {get: () => window.__hidden});
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (e) => {
        if (e.data?.results?.some((r) => r.bitmap)) window.__bitmaps.push(Date.now());
        if (e.data?.type === 'connected') window.__connected.push(Date.now());
      });
    }
  };
};

const browser = await chromium.launch({
  channel: 'chrome', headless: !opts.headed,
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});

async function runPan(name, rate) {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  await page.addInitScript(initScript);
  await page.goto(base);
  await page.waitForFunction(() => window.__bitmaps.length > 0, null, {timeout: 15000});
  await page.mouse.move(640, 400);
  for (let i = 0; i < 100; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(10);
  }
  await page.waitForTimeout(3000);

  log = [];
  messages = [];
  kbps = rate;
  const start = Date.now();
  await page.mouse.down();
  for (let x = 0; Date.now() - start < opts.timeout; x++) {
    await page.mouse.move(640 - (x % 600), 400);
    if (x % 600 === 599) {
      await page.mouse.up();
      await page.mouse.move(640, 400);
      await page.mouse.down();
    }
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  // Stay throttled for a while, so a reconnect caused by the pan stopping would show up here.
  await page.waitForTimeout(5000);
  kbps = 0;
  const bitmaps = await page.evaluate((t) => window.__bitmaps.filter((b) => b > t).length, start);
  await page.close();
  breakSockets('kill');

  const reconnects = log.filter((e) => e.what === 'ws open');
  let maxGap = 0;
  for (let i = 1; i < messages.length; i++) maxGap = Math.max(maxGap, messages[i][0] - messages[i - 1][0]);
  const maxKb = Math.max(0, ...messages.map(([, b]) => b)) / 1024;
  const totalKb = messages.reduce((sum, [, b]) => sum + b, 0) / 1024;
  const at = reconnects.map((e) => `${((e.t - start) / 1000).toFixed(1)}s`).join(' ');
  console.log(`${name.padEnd(18)} false reconnects: ${String(reconnects.length).padEnd(4)} bitmaps: ${String(bitmaps).padEnd(6)} msgs ${messages.length}, largest ${maxKb.toFixed(0)} KB, total ${totalKb.toFixed(0)} KB, longest gap ${(maxGap / 1000).toFixed(2)}s raw ${(rawBytes / 1024).toFixed(0)} KB  ${at}`);
}

async function runScenario(name) {
  const pan = /^pan(\d+)k$/.exec(name);
  if (pan) return runPan(name, Number(pan[1]));
  const hidden = /^hidden(\d+)$/.exec(name);
  const m = /^(?:sleep(\d+)-)?(kill|halfopen)$/.exec(name);
  if (!m && !hidden) throw new Error(`unknown scenario ${name}`);
  const sleepMs = Number(m?.[1] ?? 0) * 1000;
  const mode = m?.[2] ?? 'none';

  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  await page.addInitScript(initScript);
  await page.goto(base);
  await page.waitForFunction(() => window.__bitmaps.length > 0, null, {timeout: 15000});
  await page.waitForTimeout(3000);

  log = [];
  const faultAt = Date.now();
  mark(`fault ${mode}`);
  if (hidden) {
    const setHidden = (value) => page.evaluate((v) => {
      window.__hidden = v;
      window.__wakeAt = Date.now();
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    await setHidden(true);
    await page.waitForTimeout(Number(hidden[1]) * 1000);
    await setHidden(false);
  } else if (sleepMs > 0) {
    await page.evaluate(() => {
      window.__hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    breakSockets(mode);
    await page.evaluate((ms) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `/__sleep?ms=${ms}`, false);
      xhr.send();
      window.__wakeAt = Date.now();
      window.__hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    }, sleepMs);
  } else {
    breakSockets(mode);
  }
  const wakeAt = sleepMs > 0 || hidden ? await page.evaluate(() => window.__wakeAt) : faultAt;
  if (sleepMs > 0 || hidden) log.push({t: wakeAt, what: 'wake'});

  // Blocks already on their way still decode after a fault, so with a broken socket only a bitmap after a
  // new STOMP connection counts.
  let recoveredAt = null;
  for (const deadline = wakeAt + opts.timeout; recoveredAt === null && Date.now() < deadline;) {
    recoveredAt = await page.evaluate(({fault, wake, broken}) => {
      const connected = broken ? window.__connected.find((c) => c >= fault) : wake;
      return connected === undefined ? null : window.__bitmaps.find((b) => b > Math.max(connected, wake)) ?? null;
    }, {fault: faultAt, wake: wakeAt, broken: mode !== 'none'});
    if (recoveredAt === null) await page.waitForTimeout(50);
  }
  if (recoveredAt !== null) await page.waitForTimeout(1500);
  const after = await page.evaluate((t) => window.__bitmaps.filter((b) => b > t).length, wakeAt);
  await page.close();
  breakSockets('kill');

  const timeline = log.sort((a, b) => a.t - b.t).map((e) => `${((e.t - wakeAt) / 1000).toFixed(2)}s ${e.what}`).join(' | ');
  const took = recoveredAt === null ? `no bitmap within ${opts.timeout / 1000}s` : `${((recoveredAt - wakeAt) / 1000).toFixed(2)}s`;
  console.log(`${name.padEnd(18)} ${took.padEnd(24)} bitmaps after: ${String(after).padEnd(4)} ${timeline}`);
}

for (let run = 0; run < opts.runs; run++) {
  for (const name of opts.scenarios.split(',')) await runScenario(name);
}
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]);
server.close();
process.exit(0);
