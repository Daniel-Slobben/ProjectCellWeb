// Runs the drawing bench scenarios in real browsers and prints a summary table.
//
//   node bench/run.mjs [--browsers chrome,firefox,webkit] [--scenarios all|pan-min-fast,zoom-rapid,...]
//                      [--duration 4000] [--label baseline] [--compare latest|<runId>] [--headless]
//                      [--viewport 1728x1117] [--dpr 2] [--tick 250] [--dist path/to/build/browser] [--pattern recorded|noise]
//                      [--mbps 9] [--trace]
//
// --trace (Chrome) records a trace of each scenario's measured part next to its results, for the Performance panel, and
// prints where the workers spent their time: self ms per function. A development build keeps the function names:
// npx ng build --configuration development --output-path /tmp/cells-dev, then --dist=/tmp/cells-dev/browser.
//
// Browsers open as windows by default, one per browser, and the scenarios load one after another in it. On macOS
// the app that was in front gets the focus back once the window is open. Results are written to
// bench/results/<runId>.json, the same files the in-page panel reads, so CLI and manual runs can be compared.
// Needs a production build (npx ng build); `npm run bench` does both.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium, firefox, webkit} from 'playwright-core';
import {parseArgs, startServer} from './server.mjs';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(benchDir, 'results');

const opts = parseArgs(process.argv.slice(2), {
  browsers: 'chrome', scenarios: 'default', duration: 4000, label: '', compare: '', headless: false, dist: '',
  viewport: '1728x1117', dpr: 2, tick: 250, blockSize: 2000, density: 1 / 6, port: 0, pattern: 'recorded', mbps: 0, trace: false,
});
const [width, height] = opts.viewport.split('x').map(Number);

const launchers = {
  chrome: () => chromium.launch({
    channel: 'chrome', headless: opts.headless,
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  }),
  chromium: () => chromium.launch({headless: opts.headless}),
  firefox: () => firefox.launch({headless: opts.headless}),
  webkit: () => webkit.launch({headless: opts.headless}),
};

// [header, path, digits, lower is better]
const columns = [
  ['fps', 'frames.fps', 0, false],
  ['p95', 'frames.p95', 1, true],
  ['max', 'frames.max', 0, true],
  ['drop', 'frames.dropped', 0, true],
  ['>50', 'frames.over50', 0, true],
  ['ws', 'frames.over50By.ws', 0, true],
  ['drw', 'frames.over50By.draw', 0, true],
  ['oth', 'frames.over50By.other', 0, true],
  ['drw95', 'draw.appMsP95', 2, true],
  ['cnv95', 'draw.canvasMsP95', 2, true],
  ['srcMpx', 'draw.srcMpxP50', 1, true],
  ['newMpx/s', 'draw.newMpxPerSec', 0, true],
  ['liveMB', 'workers.liveBitmapMBPeak', 0, true],
  ['cover', 'coverage.min', 2, false],
  ['end', 'coverage.end', 2, false],
  ['wsMs', 'main.wsHandlerTotalMs', 0, true],
  ['sockW', 'main.socketWorkerTotalMs', 0, true],
  ['commit', 'main.workerReplyTotalMs', 0, true],
  ['tick95', 'latency.tickToDrawP95', 0, true],
  ['in95', 'latency.inputToDrawP95', 0, true],
  ['LoAF', 'loaf.blockingMs', 0, true],
];
// Chrome takes the focus for every new window and Firefox when it starts; WebKit leaves it. All three kept drawing at
// their full frame rate behind other windows (macOS, 2026-11-16).
function frontApp() {
  if (process.platform !== 'darwin' || opts.headless) return null;
  try {
    const asn = execFileSync('lsappinfo', ['front']).toString().trim();
    return /"LSBundlePath"="([^"]+)"/.exec(execFileSync('lsappinfo', ['info', '-only', 'bundlepath', asn]).toString())?.[1] ?? null;
  } catch {
    return null;
  }
}
const front = frontApp();

const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

function table(results, baseline) {
  const base = new Map((baseline?.results ?? []).map((r) => [r.scenario, r]));
  const rows = [['scenario', 'cellSize', ...columns.map((c) => c[0])]];
  const notes = [];
  for (const r of results) {
    if (r.error || r.skipped) { notes.push(`${r.scenario}: ${r.skipped ? 'skipped, ' + r.skipped : 'ERROR ' + r.error.split('\n')[0]}`); continue; }
    const cs = r.zoom.cellSizeMin === r.zoom.cellSizeMax ? `${r.zoom.cellSizeMin}` : `${r.zoom.cellSizeMin}-${r.zoom.cellSizeMax}`;
    const b = base.get(r.scenario);
    rows.push([r.scenario + (r.settle?.settled === false ? '*' : ''), cs, ...columns.map(([, p, digits, lowerBetter]) => {
      const v = get(r, p);
      if (v == null) return '-';
      const bv = b ? get(b, p) : null;
      let s = Number(v).toFixed(digits);
      if (bv != null && bv !== 0 && Math.abs(v - bv) / Math.abs(bv) >= 0.05) {
        const better = lowerBetter ? v < bv : v > bv;
        s += `${better ? '\x1b[32m' : '\x1b[31m'}${v > bv ? '+' : ''}${Math.round((v - bv) / Math.abs(bv) * 100)}%\x1b[0m`;
      }
      return s;
    })]);
  }
  // eslint-disable-next-line no-control-regex
  const visible = (s) => String(s).replace(/\x1b\[\d+m/g, '').length;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] === undefined ? 0 : visible(r[i])))));
  return rows.map((r) => r.map((c, i) => {
    const pad = ' '.repeat(Math.max(0, widths[i] - visible(c ?? '')));
    return i < 2 ? (c ?? '') + pad : pad + (c ?? '');
  }).join('  ')).concat(notes).join('\n');
}

/** Self ms per function over the worker threads of a Chrome trace, the largest first, and the busy ms per thread. */
function workerProfile(trace, top = 20) {
  const events = trace.traceEvents ?? trace;
  const threadNames = new Map(events.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => [`${e.pid}:${e.tid}`, e.args.name]));
  const workerProfiles = new Set(events.filter((e) => e.name === 'Profile' && threadNames.get(`${e.pid}:${e.tid}`) === 'DedicatedWorker thread')
    .map((e) => `${e.pid}:${e.id}`));
  const nodes = new Map(), samples = new Map();
  for (const e of events) {
    const id = `${e.pid}:${e.id}`;
    if (e.name !== 'ProfileChunk' || !workerProfiles.has(id)) continue;
    const {cpuProfile = {}, timeDeltas = []} = e.args.data;
    for (const node of cpuProfile.nodes ?? []) {
      const {functionName, url, lineNumber} = node.callFrame;
      nodes.set(`${id}:${node.id}`, `${functionName || '(anonymous)'}${url ? ` ${path.basename(url)}:${lineNumber + 1}` : ''}`);
    }
    if (!samples.has(id)) samples.set(id, {nodes: [], timeDeltas: []});
    samples.get(id).nodes.push(...(cpuProfile.samples ?? []));
    samples.get(id).timeDeltas.push(...timeDeltas);
  }
  const self = new Map(), busy = new Map();
  for (const [id, profile] of samples) {
    profile.nodes.forEach((node, i) => {
      const name = nodes.get(`${id}:${node}`), ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
      self.set(name, (self.get(name) ?? 0) + ms);
      if (name !== '(idle)' && name !== '(program)') busy.set(id, (busy.get(id) ?? 0) + ms);
    });
  }
  const total = [...busy.values()].reduce((a, b) => a + b, 0);
  return `workers busy ${total.toFixed(0)} ms (per thread: ${[...busy.values()].map((ms) => ms.toFixed(0)).join(', ')}), self ms:\n` +
    [...self].filter(([name]) => name !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([name, ms]) => `  ${ms.toFixed(0).padStart(6)} ms ${(100 * ms / total).toFixed(1).padStart(5)}%  ${name}`).join('\n');
}

function loadRun(idOrFile) {
  const file = fs.existsSync(idOrFile) ? idOrFile : path.join(resultsDir, `${idOrFile}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function findBaseline(browser, excludeRunId) {
  if (!opts.compare) return null;
  if (opts.compare !== 'latest') return loadRun(opts.compare);
  if (!fs.existsSync(resultsDir)) return null;
  return fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.trace.json')).map((f) => loadRun(path.join(resultsDir, f)))
    .filter((r) => r && r.runId !== excludeRunId && r.meta?.browser === browser && (r.meta.pattern ?? 'noise') === info.pattern)
    .sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt))[0] ?? null;
}

const server = await startServer({port: opts.port, tick: opts.tick, blockSize: opts.blockSize, density: opts.density, dist: opts.dist,
  pattern: opts.pattern, mbps: opts.mbps, quiet: true});
const info = await (await fetch(`${server.url}__bench/info`)).json();
console.log(`commit ${info.commit}${info.dirty.length ? ' + uncommitted: ' + info.dirty.join(', ') : ''}; ${info.pattern}, blockSize ${info.blockSize}, tick ${info.tickMs} ms, ${info.mbps ? `${info.mbps} Mbit/s, ` : ''}` +
  `viewport ${width}x${height} @${opts.dpr}x, ${opts.duration / 1000} s per scenario`);

let exitCode = 0;
try {
  for (const browserName of opts.browsers.split(',')) {
    const launch = launchers[browserName];
    if (!launch) throw new Error(`unknown browser ${browserName} (chrome, chromium, firefox, webkit)`);
    const browser = await launch();
    const context = await browser.newContext({viewport: {width, height}, screen: {width, height}, deviceScaleFactor: opts.dpr, hasTouch: true});
    const page = await context.newPage();
    if (front) execFileSync('open', ['-a', front]);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.url}?bench=ui`);
    const known = await page.evaluate(() => window.__bench.scenarios);
    // An unrecorded warm-up: the first page in a fresh browser pays for shader and JIT warm-up
    // (Firefox's first scenario was consistently slower in its canvas calls).
    await page.goto(`${server.url}?bench=idle-min&duration=1500&auto=1`);
    await page.waitForFunction(() => window.__benchResult, null, {timeout: 60000, polling: 250}).catch(() => {});
    const names = opts.scenarios === 'all' ? known.map((s) => s.name)
      : opts.scenarios === 'default' ? known.filter((s) => !s.extra).map((s) => s.name) : opts.scenarios.split(',');

    const startedAt = new Date().toISOString();
    const runId = `${startedAt.slice(0, 19).replace(/[:T]/g, '-')}-${browserName}${opts.label ? '-' + opts.label : ''}`;
    const run = {runId, meta: {runId, label: opts.label, browser: browserName, version: browser.version(), startedAt, commit: info.commit,
      dirty: info.dirty, durationMs: opts.duration, tickMs: info.tickMs, blockSize: info.blockSize, pattern: info.pattern, density: info.density, mbps: info.mbps,
      viewport: [width, height], dpr: opts.dpr, headless: opts.headless, dist: info.dist}, results: []};
    console.log(`\n${browserName} ${browser.version()} -> bench/results/${runId}.json`);

    for (const name of names) {
      errors.length = 0;
      const t0 = Date.now();
      let result;
      let tracing = false;
      try {
        const traced = opts.trace && browserName !== 'firefox' && browserName !== 'webkit';
        await page.goto(`${server.url}?bench=${encodeURIComponent(name)}&duration=${opts.duration}&auto=1${traced ? '&trace=1' : ''}`);
        if (traced) {
          await page.waitForFunction(() => window.__benchAwaitingTrace || window.__benchResult, null, {timeout: 90000, polling: 50});
          if (await page.evaluate(() => !window.__benchAwaitingTrace)) throw new Error('the scenario ended before tracing started');
          await browser.startTracing(page, {categories: ['__metadata', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
            'disabled-by-default-v8.cpu_profiler', 'v8']});
          tracing = true;
          await page.evaluate(() => { window.__benchTracing = true; });
        }
        await page.waitForFunction(() => window.__benchResult, null, {timeout: opts.duration + 90000, polling: 250});
        result = await page.evaluate(() => window.__benchResult);
        if (tracing) {
          tracing = false;
          const trace = await browser.stopTracing();
          fs.mkdirSync(resultsDir, {recursive: true});
          fs.writeFileSync(path.join(resultsDir, `${runId}-${name}.trace.json`), trace);
          console.log(workerProfile(JSON.parse(trace.toString())));
        }
      } catch (e) {
        result = {scenario: name, error: String(e.message ?? e)};
      } finally {
        if (tracing) await browser.stopTracing().catch(() => {});
      }
      if (errors.length) result.pageErrors = errors.slice(0, 5);
      run.results.push(result);
      fs.mkdirSync(resultsDir, {recursive: true});
      fs.writeFileSync(path.join(resultsDir, `${runId}.json`), JSON.stringify(run, null, 1));
      const f = result.frames;
      console.log(`  ${name.padEnd(16)} ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} s  ` +
        (result.error ? `ERROR ${result.error.split('\n')[0]}` : result.skipped ? `skipped: ${result.skipped}` :
          `fps ${f.fps}, p95 ${f.p95} ms, max ${f.max} ms${result.settle?.settled === false ? ' (never fully covered before measuring)' : ''}`));
    }

    const baseline = findBaseline(browserName, runId);
    console.log(`\n${table(run.results, baseline)}`);
    if (baseline) console.log(`deltas vs ${baseline.runId} (shown when ≥ 5%)`);
    // Chrome can take ~20 s to close after heavy runs; Playwright kills it when this process exits.
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
  }
  console.log(`\ncolumns: fps, frame p95/max ms, dropped frames (> 1.5 refresh), frames > 50 ms, ms in the app's frame callback when it drew (p95),
  of which in canvas calls (p95),
  bitmap Mpx per redraw, Mpx/s of bitmaps drawn for the first time, peak MB of live bitmaps, min and end screen coverage,
  main-thread ms handling socket messages, ms in the socket worker's handler (off the main thread), ms in worker replies, tick->draw p95 ms, input->draw p95 ms, Long Animation Frame blocking ms (Chromium).
  ws/drw/oth split the >50 ms frames by cause: STOMP handler, the app's frame callback (drawing), or no main-thread work (GPU, GC).
  * = blocks never fully covered the screen before measuring. Open ${server.url}?bench=ui for the same table in the browser.`);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await server.close();
}
process.exit(exitCode);
