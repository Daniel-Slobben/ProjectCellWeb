// Times the decode worker's work per block and tick on the recorded world: the GoL step, the border, and per pool factor
// the image and the bitmap.
//
//   node bench/worker/run.mjs [--baseline 7345ed3] [--browsers chrome,firefox,webkit] [--pf 1,2,4,8,16,32] [--generations 20]
//                             [--blocks 0] [--activity] [--profile] [--recording bench/recordings/world.bin]
//
// The functions are bundled from decompress-block.worker.ts itself by bundle.mjs, so whatever is in the worker is what
// gets measured. --baseline bundles the worker of that commit too and runs it in lockstep: its numbers come first, and
// every image of the two must be the same.
// Node has no canvas, so it times no bitmaps. Browsers run headless, in a worker like the app's, on a cross-origin
// isolated page so performance.now() has a fine resolution. --activity reports how much of a block a tick touches.
// --profile samples where the time goes, in Node and Chrome: self ms per function, summed over the run. Node counts the
// functions V8 inlined as their caller's time; Chrome lists them on their own.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync} from 'node:child_process';
import {Session} from 'node:inspector/promises';
import {parseArgs} from '../server.mjs';
import {bundleWorker, workerPath} from './bundle.mjs';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(workerDir, '../..');
const opts = parseArgs(process.argv.slice(2), {
  baseline: '', browsers: '', pf: '1,2,4,8,16,32', generations: 20, blocks: 0, activity: false, profile: false,
  recording: path.join(workerDir, '../recordings/world.bin'),
});
const runOptions = {pfs: opts.pf.split(',').map(Number), generations: opts.generations, blocks: opts.blocks, compare: !!opts.baseline};

const buildDir = path.join(workerDir, '.build');
fs.mkdirSync(buildDir, {recursive: true});
await bundleWorker(fs.readFileSync(workerPath, 'utf8'), path.join(buildDir, 'current.mjs'));
if (opts.baseline) {
  const source = execSync(`git show ${opts.baseline}:${path.relative(projectDir, workerPath)}`, {cwd: projectDir, maxBuffer: 1 << 24}).toString();
  await bundleWorker(source, path.join(buildDir, 'baseline.mjs'));
} else {
  fs.writeFileSync(path.join(buildDir, 'baseline.mjs'), `export {worker} from './current.mjs';\n`);
}
const recording = fs.readFileSync(opts.recording);

function report(name, r) {
  const ms = (m) => `${m.avg.toFixed(2).padStart(5)} (${m.p50.toFixed(2)}, ${m.p90.toFixed(2)})`;
  console.log(`${name}: ${r.blocks} blocks x ${r.ticks / r.blocks} ticks${r.gaps ? `, ${r.gaps} GENERATION GAPS` : ''}` +
    `${r.differences === null ? '' : r.differences ? `, IMAGES DIFFER ${r.differences} TIMES` : ', images the same'}; ms per block, avg (p50, p90):`);
  for (const v of r.versions) {
    console.log(`  ${opts.baseline ? `${v.name === 'baseline' ? opts.baseline : 'current'}: `.padEnd(10) : ''}FULL ${ms(v.full)}, step ${ms(v.step)}, border ${ms(v.border)}`);
    for (const {pf, image, bitmap} of v.pools) {
      const total = v.step.avg + v.border.avg + image.avg + (bitmap?.avg ?? 0);
      console.log(`    pf ${String(pf).padStart(2)}: image ${ms(image)}${bitmap ? `, bitmap ${ms(bitmap)}` : ''}, tick ${total.toFixed(2)}`);
    }
  }
}

/** Self ms per function of a V8 CPU profile, the largest first. */
function summarise(profile, top = 15) {
  const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const {functionName, url, lineNumber} = byId.get(id).callFrame;
    const name = `${functionName || '(anonymous)'}${url ? ` ${path.basename(url)}:${lineNumber + 1}` : ''}`;
    self.set(name, (self.get(name) ?? 0) + profile.timeDeltas[i] / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([name, ms]) => `    ${ms.toFixed(0).padStart(6)} ms ${(100 * ms / total).toFixed(1).padStart(5)}%  ${name}`).join('\n');
}

const harness = await import(path.join(workerDir, 'harness.mjs'));
if (opts.activity) {
  const shares = await harness.activity(recording, {generations: opts.generations, blocks: opts.blocks});
  const pc = (v) => `${(100 * v).toFixed(1)}%`.padStart(6);
  console.log(`activity per block and tick, avg / p90 / max:\n${Object.entries(shares)
    .map(([name, s]) => `  ${pc(s.avg)} ${pc(s.p90)} ${pc(s.max)}  ${name}`).join('\n')}`);
}
if (opts.profile) {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', {interval: 200});
  await session.post('Profiler.start');
  report('node', await harness.run(recording, runOptions));
  console.log(summarise((await session.post('Profiler.stop')).profile));
} else {
  report('node', await harness.run(recording, runOptions));
}

if (opts.browsers) {
  const {chromium, firefox, webkit} = await import('playwright-core');
  const launchers = {chrome: () => chromium.launch({channel: 'chrome'}), chromium: () => chromium.launch(), firefox: () => firefox.launch(), webkit: () => webkit.launch()};
  const isolated = {'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp'};
  const page = `<!doctype html><script type="module">
    import * as h from '/harness.mjs';
    const recording = fetch('/recording').then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
    window.inPage = async (options) => h.run(await recording, options);
    window.inWorker = (options) => new Promise((resolve, reject) => {
      const worker = new Worker('/entry.mjs', {type: 'module'});
      worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage(options);
    });
    window.ready = true;
  </script>`;
  // The worker's own onmessage is set when the bundle loads; this one replaces it.
  const entry = `import {run} from '/harness.mjs';
    onmessage = async (e) => postMessage(await run(new Uint8Array(await (await fetch('/recording')).arrayBuffer()), e.data));`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    const send = (type, body) => { res.writeHead(200, {'content-type': type, ...isolated}); res.end(body); };
    if (url === '/') return send('text/html', page);
    if (url === '/entry.mjs') return send('text/javascript', entry);
    if (url === '/recording') return send('application/octet-stream', recording);
    const file = path.join(workerDir, url);
    if (!file.startsWith(workerDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    send('text/javascript', fs.readFileSync(file));
  }).listen(0);
  try {
    for (const name of opts.browsers.split(',')) {
      const browser = await launchers[name]();
      const tab = await browser.newPage();
      await tab.goto(`http://localhost:${server.address().port}/`);
      await tab.waitForFunction(() => window.ready);
      report(name, await tab.evaluate((o) => window.inWorker(o), runOptions));
      if (opts.profile && name !== 'firefox' && name !== 'webkit') {
        // CDP reaches the page, not its workers: the profiled run is on the page itself.
        const cdp = await tab.context().newCDPSession(tab);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', {interval: 200});
        await cdp.send('Profiler.start');
        report(`${name} (page, profiled)`, await tab.evaluate((o) => window.inPage(o), runOptions));
        console.log(summarise((await cdp.send('Profiler.stop')).profile));
      }
      await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
    }
  } finally {
    server.close();
  }
}
process.exit(0);
