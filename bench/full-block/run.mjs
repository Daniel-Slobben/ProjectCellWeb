// Checks and times FULL blocks as runs of strips (readStrips in block-frame.ts) against FULL blocks as zstd of the rows,
// as the backend sent them before strips.
//
//   node bench/full-block/run.mjs --data <dir> [--browsers chrome,firefox,webkit] [--rounds 3]
//
// <dir> holds i.zst and i.full per block, or folders of them, written by CellService's FullBlockChaosTest with
// -Dchaos.write=<dir>: zstd 3 of the rows and the Packer's FULL payload of the same cells, one folder per age of the
// chaos hit. Node runs first, then each browser headless, on a cross-origin isolated page so performance.now() has a fine
// resolution.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';
import {parseArgs} from '../server.mjs';

const blockDir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(blockDir, '.build');
const opts = parseArgs(process.argv.slice(2), {data: '', browsers: '', rounds: 3, size: 2000});
if (!opts.data) throw new Error('--data <dir> with the i.zst and i.full files of FullBlockChaosTest -Dchaos.write');

await esbuild.build({
  entryPoints: [path.resolve(blockDir, '../../src/app/features/world-of-cells/grid-view/block-frame.ts')],
  bundle: true, format: 'esm', target: 'es2022', outfile: path.join(buildDir, 'block-frame.mjs'), logLevel: 'error',
});
await esbuild.build({
  stdin: {contents: `export {ZSTDDecoder} from 'zstddec';`, resolveDir: blockDir},
  bundle: true, format: 'esm', target: 'es2022', outfile: path.join(buildDir, 'zstddec.mjs'), logLevel: 'error',
});

function readBlocks(dir) {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.full')).map((f) => f.slice(0, -5)).sort((a, b) => a - b);
  const parts = [new Uint32Array([opts.size, names.length])];
  for (const name of names) {
    const rows = fs.readFileSync(path.join(dir, `${name}.zst`)), full = fs.readFileSync(path.join(dir, `${name}.full`));
    parts.push(new Uint32Array([rows.length, full.length]), rows, full);
  }
  return Buffer.concat(parts.map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength)));
}

const folders = fs.readdirSync(opts.data, {withFileTypes: true}).filter((f) => f.isDirectory()).map((f) => f.name)
  .sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
const groups = folders.length ? folders.map((name) => ({name, blocks: readBlocks(path.join(opts.data, name))})) : [{name: '', blocks: readBlocks(opts.data)}];
const width = Math.max(...groups.map((g) => g.name.length));

const harness = await import(path.join(blockDir, 'harness.mjs'));
for (const group of groups) {
  console.log(`node     ${group.name.padEnd(width)} ${await harness.run(new Uint8Array(group.blocks), opts.rounds)}`);
}

if (opts.browsers) {
  const {chromium, firefox, webkit} = await import('playwright-core');
  const launchers = {chrome: () => chromium.launch({channel: 'chrome'}), chromium: () => chromium.launch(), firefox: () => firefox.launch(), webkit: () => webkit.launch()};
  const isolated = {'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp'};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    if (url === '/') {
      res.writeHead(200, {'content-type': 'text/html', ...isolated});
      return res.end('<!doctype html><script type="module">import * as h from "/harness.mjs"; window.h = h; window.ready = true;</script>');
    }
    if (url.startsWith('/blocks/')) {
      res.writeHead(200, {'content-type': 'application/octet-stream', ...isolated});
      return res.end(groups[Number(url.slice(8))].blocks);
    }
    const file = path.join(blockDir, url);
    if (!file.startsWith(blockDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'content-type': 'text/javascript', ...isolated});
    res.end(fs.readFileSync(file));
  }).listen(0);
  try {
    for (const name of opts.browsers.split(',')) {
      const browser = await launchers[name]();
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.address().port}/`);
      await page.waitForFunction(() => window.ready);
      for (let i = 0; i < groups.length; i++) {
        const result = await page.evaluate(async ({i, rounds}) => {
          const buffer = new Uint8Array(await (await fetch(`/blocks/${i}`)).arrayBuffer());
          return `${crossOriginIsolated ? '' : '(not isolated) '}${await window.h.run(buffer, rounds)}`;
        }, {i, rounds: opts.rounds});
        console.log(`${name.padEnd(8)} ${groups[i].name.padEnd(width)} ${result}`);
      }
      await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
    }
  } finally {
    server.close();
  }
}
process.exit(0);
