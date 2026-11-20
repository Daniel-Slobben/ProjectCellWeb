// Runs draw-calls.html in each browser: frame rate of many small drawImage calls against one atlas or one image.
//   node bench/draw-calls.mjs [--browsers chrome,webkit,firefox] [--blocks 16] [--viewport 1728x1117] [--dpr 2] [--variants bitmaps,atlas,atlasBitmap,view]
import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {chromium, firefox, webkit} from 'playwright-core';

const {values: opts} = parseArgs({options: {
  browsers: {type: 'string', default: 'chrome,webkit,firefox'},
  blocks: {type: 'string', default: '16'},
  viewport: {type: 'string', default: '1728x1117'},
  dpr: {type: 'string', default: '2'},
  variants: {type: 'string', default: 'bitmaps,atlas,atlasBitmap,view'},
}});
const page = readFileSync(new URL('./draw-calls.html', import.meta.url));
const server = createServer((req, res) => res.writeHead(200, {'content-type': 'text/html'}).end(page)).listen(0);
const port = server.address().port;
const engines = {chrome: [chromium, {channel: 'chrome'}], webkit: [webkit, {}], firefox: [firefox, {}]};
const [width, height] = opts.viewport.split('x').map(Number);

for (const name of opts.browsers.split(',')) {
  const [engine, launch] = engines[name];
  const browser = await engine.launch({headless: false, ...launch});
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: Number(opts.dpr)});
  const tab = await context.newPage();
  await tab.goto(`http://localhost:${port}/?blocks=${opts.blocks}&variants=${opts.variants}`);
  const r = await tab.waitForFunction(() => window.__results, null, {timeout: 120_000, polling: 500}).then((h) => h.jsonValue());
  console.log(`${name} ${browser.version()}: ${r.count} blocks of ${r.blockPx} px, ${r.width}x${r.height} @${r.ratio}`);
  for (const x of r.results) console.log(`  ${x.name.padEnd(8)} fps ${String(x.fps).padStart(5)}  frame p50 ${x.frameP50} p95 ${x.frameP95}  js p50 ${x.jsP50}`);
  await browser.close();
}
server.close();
