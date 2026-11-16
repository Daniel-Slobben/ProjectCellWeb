// Records what a CellWeb backend sends a browser, so the bench's mock can replay a real world instead of random noise.
//
//   node bench/record.mjs [--url https://world-of-cells.net] [--blocks 12x8] [--generations 120] [--out bench/recordings/world.bin]
//
// Like the app, it asks /gen-api/settings for a viewport and subscribes to the blocks around it, here a fixed
// rectangle of them. Per block it keeps the FULL and the BORDERs of the generations after it. The file is one line of
// JSON (url, recordedAt, blockSize, targetSpeed, viewport), then per block its FULL and its BORDERs in order, in the
// layout of src/app/features/world-of-cells/grid-view/block-frame.ts. Blocks that don't exist there are left out.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from './server.mjs';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const opts = parseArgs(process.argv.slice(2), {
  url: 'https://world-of-cells.net', blocks: '12x8', generations: 120, out: path.join(benchDir, 'recordings/world.bin'),
});
const [columns, rows] = opts.blocks.split('x').map(Number);

const {blockSize, viewport, targetSpeed} = await (await fetch(new URL('/gen-api/settings', opts.url))).json();
const left = Math.floor(viewport.x / blockSize) - (columns >> 1), top = Math.floor(viewport.y / blockSize) - (rows >> 1);
const blocks = new Map();
for (let y = top; y < top + rows; y++) for (let x = left; x < left + columns; x++) blocks.set(`${x}/${y}`, {full: null, borders: new Map()});
console.log(`${opts.url}: blockSize ${blockSize}, targetSpeed ${targetSpeed} ms, viewport ${viewport.x}/${viewport.y}; ` +
  `recording ${columns}x${rows} blocks from ${left}/${top} for ${opts.generations} generations`);

const wsUrl = new URL('/ws', opts.url);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(wsUrl, ['v12.stomp']);
ws.binaryType = 'arraybuffer';
const send = (command, headers, body = '') =>
  ws.send(`${command}\n${Object.entries(headers).map(([k, v]) => `${k}:${v}\n`).join('')}\n${body}\0`);

let ticks = 0;
const done = new Promise((resolve, reject) => {
  ws.onopen = () => send('CONNECT', {'accept-version': '1.2', 'heart-beat': '0,0'});
  ws.onerror = (e) => reject(new Error(`socket: ${e.message}`));
  ws.onclose = () => reject(new Error('socket closed'));
  ws.onmessage = ({data}) => {
    if (typeof data === 'string') {
      if (data.startsWith('CONNECTED')) {
        send('SUBSCRIBE', {id: 'sub-0', destination: '/user/queue/blocks'});
        send('SEND', {destination: '/client-update', 'content-type': 'application/json'},
          JSON.stringify({blocksToRemove: [], blocksToAdd: [...blocks.keys()]}));
      } else if (data.startsWith('ERROR') || data.includes('NO_BLOCKS')) {
        reject(new Error(data.replace(/\0$/, '')));
      }
      return;
    }
    const message = Buffer.from(data);
    const split = message.indexOf('\n\n');
    const length = /content-length:(\d+)/.exec(message.toString('latin1', 0, split))?.[1];
    const body = message.subarray(split + 2, length === undefined ? message.length - 1 : split + 2 + Number(length));
    for (let i = 0; i < body.length;) {
      const end = i + 17 + body.readUInt32LE(i + 13);
      const block = blocks.get(`${body.readInt32LE(i)}/${body.readInt32LE(i + 4)}`);
      const generation = body.readUInt32LE(i + 9), frame = Buffer.from(body.subarray(i, end));
      // the last FULL: a new session gets each block again as a FULL on its first tick
      if (body[i + 8] === 0) block.full = {generation, frame};
      else block.borders.set(generation, frame);
      i = end;
    }
    // FULLs come one per message; every tick brings one message with all BORDERs, empty while there are none.
    if (body.length > 0 && body[8] === 0) return;
    if (++ticks % 10 === 0) {
      const fulls = [...blocks.values()].filter((b) => b.full);
      console.log(`  tick ${ticks}: ${fulls.length} FULLs, ${(fulls.reduce((s, b) => s + b.full.frame.length, 0) / 1e6).toFixed(1)} MB`);
    }
    if (ticks >= opts.generations + 5) resolve();
  };
});
try {
  await done;
} finally {
  ws.onclose = null;
  ws.close();
}

const parts = [Buffer.from(JSON.stringify({url: opts.url, recordedAt: new Date().toISOString(), blockSize, targetSpeed, viewport}) + '\n')];
let kept = 0, fullBytes = 0, borderBytes = 0, shortest = Infinity;
for (const {full, borders} of blocks.values()) {
  if (!full) continue;
  kept++;
  parts.push(full.frame);
  fullBytes += full.frame.length;
  let n = 0;
  for (let g = full.generation + 1; n < opts.generations && borders.has(g); g++, n++) {
    parts.push(borders.get(g));
    borderBytes += borders.get(g).length;
  }
  shortest = Math.min(shortest, n);
}
fs.mkdirSync(path.dirname(opts.out), {recursive: true});
fs.writeFileSync(opts.out, Buffer.concat(parts));
console.log(`${kept} of ${blocks.size} blocks exist; FULL avg ${Math.round(fullBytes / kept / 1024)} KB, ` +
  `BORDER avg ${Math.round(borderBytes / kept / opts.generations)} B, at least ${shortest} generations per block; ` +
  `${(fs.statSync(opts.out).size / 1e6).toFixed(1)} MB -> ${path.relative(process.cwd(), opts.out)}`);
process.exit(0);
