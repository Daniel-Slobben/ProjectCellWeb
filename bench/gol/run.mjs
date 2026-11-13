// Checks and times the decode worker's stepGameOfLife: the current tree against a git commit.
//
//   node bench/gol/run.mjs [--baseline b66d5cb] [--browsers chrome,firefox,webkit] [--size 2000] [--skip-verify]
//
// Both versions are bundled from decompress-block.worker.ts itself (the baseline via `git show`), with
// an export of stepGameOfLife and a blockSize setter appended. So whatever is in the worker is what gets
// measured, and any commit can serve as the baseline. The default baseline, b66d5cb, has the client's
// earlier column-sum algorithm; the current tree has the port of the backend's AlgorithmGol.
// Correctness runs in Node; timing in Node and, with --browsers, in headless browsers (pure JS, no GPU).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';
import {parseArgs} from '../server.mjs';

const golDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(golDir, '../..');
const workerPath = 'src/app/features/world-of-cells/grid-view/decompress-block.worker.ts';
const buildDir = path.join(golDir, '.build');

const opts = parseArgs(process.argv.slice(2), {baseline: 'b66d5cb', browsers: '', size: 2000, skipVerify: false});

const footer = `
export const gol = {stepGameOfLife, setBlockSize(n: number) { blockSize = n; }};
`;

async function bundle(source, name) {
  await esbuild.build({
    // Resolved next to the real worker, so its imports find the current helpers.
    stdin: {contents: source + footer, resolveDir: path.dirname(path.join(projectDir, workerPath)), sourcefile: `${name}.worker.ts`, loader: 'ts'},
    bundle: true, format: 'esm', target: 'es2022', outfile: path.join(buildDir, `${name}.mjs`), logLevel: 'error',
  });
}

fs.mkdirSync(buildDir, {recursive: true});
const baselineSource = execSync(`git show ${opts.baseline}:${workerPath}`, {cwd: projectDir, maxBuffer: 1 << 24}).toString();
await bundle(fs.readFileSync(path.join(projectDir, workerPath), 'utf8'), 'current');
await bundle(baselineSource, 'baseline');
const commit = execSync('git rev-parse --short HEAD', {cwd: projectDir}).toString().trim();
const dirty = execSync(`git status --porcelain -- ${workerPath}`, {cwd: projectDir}).toString().trim() !== '';
console.log(`current: ${commit}${dirty ? ' + uncommitted worker changes' : ''}   baseline: ${opts.baseline}`);

const harness = await import(path.join(golDir, 'harness.mjs'));
if (!opts.skipVerify) {
  const result = harness.verify();
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
    const file = path.join(golDir, url);
    if (!file.startsWith(golDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'content-type': 'text/javascript'});
    res.end(fs.readFileSync(file));
  }).listen(0);
  try {
    for (const name of opts.browsers.split(',')) {
      const browser = await launchers[name]();
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.address().port}/`);
      await page.waitForFunction(() => window.ready);
      report(name, [await page.evaluate((n) => window.h.bench({n}), opts.size)]);
      await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
    }
  } finally {
    server.close();
  }
}
process.exit(0);
