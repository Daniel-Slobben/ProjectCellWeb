// Checks and times the decode worker's Game of Life step: the current tree against a git commit.
//
//   node bench/gol/run.mjs [--baseline 7345ed3] [--browsers chrome,firefox,webkit] [--size 2000] [--skip-verify]
//
// Both versions are bundled from decompress-block.worker.ts itself (the baseline via `git show`) by
// ../worker/bundle.mjs, which exports the same calls for both. So whatever is in the worker is what gets
// measured, and any commit can serve as the baseline. The default baseline, 7345ed3, steps the whole block
// every generation; the current tree has two cell arrays per block, like the backend's AlgorithmGol.
// Correctness runs in Node; timing in Node and, with --browsers, in headless browsers (pure JS, no GPU).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from '../server.mjs';
import {bundleWorker} from '../worker/bundle.mjs';

const golDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(golDir, '../..');
const workerPath = 'src/app/features/world-of-cells/grid-view/decompress-block.worker.ts';
const buildDir = path.join(golDir, '.build');

const opts = parseArgs(process.argv.slice(2), {baseline: '7345ed3', browsers: '', size: 2000, skipVerify: false});

fs.mkdirSync(buildDir, {recursive: true});
const baselineSource = execSync(`git show ${opts.baseline}:${workerPath}`, {cwd: projectDir, maxBuffer: 1 << 24}).toString();
await bundleWorker(fs.readFileSync(path.join(projectDir, workerPath), 'utf8'), path.join(buildDir, 'current.mjs'));
await bundleWorker(baselineSource, path.join(buildDir, 'baseline.mjs'));
const commit = execSync('git rev-parse --short HEAD', {cwd: projectDir}).toString().trim();
const dirty = execSync(`git status --porcelain -- ${workerPath}`, {cwd: projectDir}).toString().trim() !== '';
console.log(`current: ${commit}${dirty ? ' + uncommitted worker changes' : ''}   baseline: ${opts.baseline}`);

const harness = await import(path.join(golDir, 'harness.mjs'));
if (!opts.skipVerify) {
  const result = await harness.verify();
  console.log(`verify: ${result.cases} cases, ${result.generations} generations, ` +
    (result.failureCount ? `${result.failureCount} FAILURES\n  ${result.failures.join('\n  ')}` : 'no differences'));
}

const report = (name, rows) => console.log(`${name.padEnd(8)} ${rows.map((r) =>
  `${r.n}²: baseline ${r.baselineMs} ms, current ${r.currentMs} ms (×${r.ratio})`).join('   ')}`);
report('node', [harness.bench({n: opts.size})]);

if (opts.browsers) {
  const {chromium, firefox, webkit} = await import('playwright-core');
  const launchers = {chrome: () => chromium.launch({channel: 'chrome'}), chromium: () => chromium.launch(), firefox: () => firefox.launch(), webkit: () => webkit.launch()};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    if (url === '/') {
      res.writeHead(200, {'content-type': 'text/html'});
      return res.end('<!doctype html><script type="module">import * as h from "/harness.mjs"; window.h = h; window.ready = true;</script>');
    }
    if (!['/harness.mjs', '/.build/current.mjs', '/.build/baseline.mjs'].includes(url)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'content-type': 'text/javascript'});
    res.end(fs.readFileSync(path.join(golDir, url)));
  }).listen(0, '127.0.0.1');
  try {
    for (const name of opts.browsers.split(',')) {
      const browser = await launchers[name]();
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.ready);
      report(name, [await page.evaluate((n) => window.h.bench({n}), opts.size)]);
      await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
    }
  } finally {
    server.close();
  }
}
process.exit(0);
