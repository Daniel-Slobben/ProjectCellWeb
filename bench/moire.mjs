// Zooms out over the mock's line pattern and measures moiré at each zoom level.
//
//   node bench/moire.mjs [--browsers chrome,firefox] [--dist path/to/build/browser] [--label name]
//                        [--viewport 1728x1117] [--dpr 2] [--shots 2.5,1.2,0.7,0.45,0.3,0.15,0.1]
//
// The mock serves alternating alive/dead lines (--pattern lines), so a correct rendering is either the
// lines themselves or flat 50% grey. Moiré shows up as slow brightness bands. For a region of the
// vertical-line block at the centre, it averages each device-pixel column and smooths that over
// four line periods (at least 8 px), which removes the lines but keeps the bands; `band` is the
// spread of what remains (max - min, 0-255). It reads the canvas itself, before the browser scales it onto the screen.
// Screenshots at the --shots cellSizes are the composited screen, at device resolution.
// Output goes to bench/results/moire-<label>/.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, firefox, webkit} from 'playwright-core';
import {parseArgs, startServer} from './server.mjs';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const opts = parseArgs(process.argv.slice(2), {
  browsers: 'chrome', dist: '', label: 'current', viewport: '1728x1117', dpr: 2, shots: '2.5,1.2,0.7,0.45,0.3,0.15,0.1',
});
const [width, height] = opts.viewport.split('x').map(Number);
const shotSizes = String(opts.shots).split(',').map(Number);
const outDir = path.join(benchDir, 'results', `moire-${opts.label}`);
fs.mkdirSync(outDir, {recursive: true});

const launchers = {
  chrome: () => chromium.launch({channel: 'chrome', headless: false}),
  firefox: () => firefox.launch({headless: false}),
  webkit: () => webkit.launch({headless: false}),
};

// Records the last block draw: its destination width gives cellSize, its bitmap width the pool factor.
const hook = () => {
  const native = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (image, ...rest) {
    if (rest.length === 4) window.__lastDraw = {bitmapWidth: image.width, dw: rest[2], smoothing: this.imageSmoothingEnabled};
    return native.call(this, image, ...rest);
  };
};

const measure = ({side, window}) => {
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  // The view centre is a quarter into the vertical-line block; the region runs right and down from it.
  const cx = Math.round(canvas.width / 2), cy = Math.round(canvas.height / 2);
  const {data} = ctx.getImageData(cx, cy, side, side);
  const columns = new Float64Array(side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) columns[x] += data[(y * side + x) * 4] / side;
  const smoothed = [];
  for (let x = 0; x + window <= side; x++) smoothed.push(columns.slice(x, x + window).reduce((a, b) => a + b) / window);
  return {band: Math.max(...smoothed) - Math.min(...smoothed), mean: columns.reduce((a, b) => a + b) / side};
};

const server = await startServer({port: 0, quiet: true, pattern: 'lines', dist: opts.dist});
try {
  for (const name of opts.browsers.split(',')) {
    const browser = await launchers[name]();
    const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: Number(opts.dpr)});
    await page.addInitScript(hook);
    await page.goto(server.url);
    await page.waitForFunction(() => window.__lastDraw);
    const box = await page.locator('canvas').boundingBox();
    await page.addStyleTag({content: '#cellweb-bench { display: none !important; }'});
    await page.waitForTimeout(1000);

    console.log(`\n${name} (${opts.label}), dpr ${opts.dpr}`);
    console.log('cellSize  dev px/cell  pool  smooth  band  mean');
    const pending = [...shotSizes].sort((a, b) => b - a);
    for (;;) {
      const draw = await page.evaluate(() => window.__lastDraw);
      const cellSize = draw.dw / 2000;
      const dppc = cellSize * Number(opts.dpr);
      // Keep the region inside the block: it reaches three quarters of a block past the centre.
      const side = Math.min(256, Math.floor(0.7 * 2000 * dppc));
      const {band, mean} = await page.evaluate(measure, {side, window: Math.max(8, Math.round(8 * dppc))});
      console.log(`${cellSize.toFixed(3).padStart(8)}  ${dppc.toFixed(3).padStart(11)}  ${String(2000 / draw.bitmapWidth).padStart(4)}  ` +
        `${String(draw.smoothing).padStart(6)}  ${band.toFixed(0).padStart(4)}  ${mean.toFixed(0).padStart(4)}`);
      if (pending.length && cellSize <= pending[0] * 1.03) {
        pending.shift();
        // A square on the block corner a quarter block up-left of the centre, so it shows both line
        // directions once the corner is on screen.
        const s = 300;
        const corner = (start, length) => Math.max(start, start + length / 2 - 500 * cellSize - s / 2);
        await page.screenshot({path: path.join(outDir, `${name}-cs${cellSize.toFixed(3)}.png`),
          clip: {x: corner(box.x, box.width), y: corner(box.y, box.height), width: s, height: s}});
      }
      if (cellSize * 0.95 < 0.1) break;
      // Two wheel steps of 0.95 each; then wait for the pooled bitmaps to come back from the workers.
      // Dispatched in the page: Playwright's mouse.wheel reached the app in bursts.
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const r = canvas.getBoundingClientRect();
        const at = {clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: 100, bubbles: true, cancelable: true};
        for (let i = 0; i < 2; i++) canvas.dispatchEvent(new WheelEvent('wheel', at));
      });
      await page.waitForTimeout(500);
    }
    await browser.close();
  }
} finally {
  await server.close();
}
console.log(`\nscreenshots in ${path.relative(process.cwd(), outDir)}`);
