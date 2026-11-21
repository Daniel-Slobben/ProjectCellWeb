# Drawing bench

Runs the real production build of CellWeb against a mock backend and drives it with scripted input:
panning at minCellSize, flings, rapid zoom in/out, pinch. Nothing in `src/` is changed for it.
`server.mjs` injects `client/bench.js` as the first script of the page. That script hooks
`drawImage`, `requestAnimationFrame`, `WebSocket` and `Worker` before the app starts, synthesises
the input as DOM events on the canvas, and summarises each scenario.

## Run it

```sh
npm run bench                                    # build, then the default set in a Chrome window
npm run bench -- --browsers chrome,firefox,webkit --label baseline
npm run bench -- --scenarios pan-min-fast,zoom-rapid --compare latest   # deltas vs the previous run
npm run bench:serve                              # build, then serve on http://localhost:4300
node bench/record.mjs                            # record world-of-cells.net again (see What the mock does)
```

With `bench:serve`, open the URL in any browser and click **bench** in the top-left corner to pick
scenarios, run them, browse earlier runs and compare against a baseline. Each scenario runs on a
fresh page load. Every run, from the CLI or the panel, is written to `bench/results/<runId>.json`,
which is git-ignored.

To compare two versions of the code side by side, build one of them elsewhere and point the runner at it:

```sh
npx ng build --output-path /tmp/cells-variant
node bench/run.mjs --dist=/tmp/cells-variant/browser --label variant --compare latest
```

Each browser gets one window, and the scenarios load one after another in it. On macOS the runner gives the
focus back to the app that was in front as soon as the window is open, so you can keep typing; that app's windows
may then cover the bench. Chrome, Firefox and WebKit all kept their frame rate when covered (Chrome's
pan-min-fast and zoom-rapid matched a run in front; Firefox's zoom-rapid was 94–97 fps covered against 98–103 in
front, within its noise). While a scenario runs, the page ignores real mouse, wheel and touch input on the canvas.
Close other heavy processes. Firefox in particular varies 20–30% from run to run, so interleave A/B runs rather
than trusting one sample.

## Scenarios

The default set has five scenarios, about 10 s each including setup:

| name | what it does |
|---|---|
| pan-min-circle | minCellSize, one continuous circular drag, r 250 px, 2 s per turn |
| pan-min-fast | minCellSize, 800 px strokes at 1600 px/s in one direction, so new blocks keep arriving |
| zoom-min-bounce | wheel at 120 Hz between minCellSize and 0.4, crossing the poolFactor steps |
| zoom-rapid | wheel at 120 Hz between 0.12 and 2.5 |
| pan-pf1-edge | 0.42 device px per cell, just above the pooling threshold: the largest bitmaps per redraw |

`--scenarios all`, or the panel, adds the extras: idle-min, pan-min-slow, fling-min, zoom-sectors, zoom-sweep,
zoom-pan-min, pinch-min (Chromium only), idle-pf1-edge, pan-close and sectors-after-pan. Run any subset with
`--scenarios a,b`.

sectors-after-pan is a check rather than a timing: it zooms out to 0.06 and drags 600 px while the full blocks are
still on their way, waits 5 s, zooms out into sectors and rests 12 s, longer than the sector period. Its `end`
should be 1.00. It needs a slow link to catch anything: `--scenarios sectors-after-pan --mbps 9`.

The setup for each scenario zooms with wheel events to the target, waits until blocks cover the
screen, and then measures for `--duration` ms. `minCellSize` is wherever the wheel stops having an effect.

## Columns

| column | meaning |
|---|---|
| fps, p95, max | intervals between frame callbacks on the main thread |
| drop, >50 | frames over 1.5 refresh intervals, and frames over 50 ms |
| ws / drw / oth | the >50 ms frames, split by what took most of them: the STOMP message handler, the app's frame callback (drawing), or no measurable main-thread work (GPU or compositor back-pressure, GC) |
| drw95, cnv95 | p95 ms of the app's frame callback in frames where it drew, and the part of that inside canvas calls. GPU work is not in these; it shows as longer frames or as `oth` |
| srcMpx | bitmap megapixels drawn per redraw. The canvas itself is 7.5 Mpx at 1728×1087 @2x |
| newMpx/s | megapixels per second of bitmaps drawn for the first time, which is what the canvas has to upload or import |
| liveMB | peak bytes of ImageBitmaps held at once |
| cover | lowest fraction of the canvas covered by blocks in any redraw (white gaps while blocks load) |
| end | fraction of the canvas covered by blocks in the last redraw |
| wsMs, commit | total main-thread ms in the STOMP handler and in worker replies (`commitBatch`) |
| tick95, in95 | p95 ms from a socket message to the first draw of its bitmaps, and from an input event to the next redraw |
| LoAF | blocking ms from Long Animation Frames (Chromium only). The JSON has the top scripts per scenario |

The JSON per scenario has more detail: bitmap sizes seen (which tell you the poolFactor), p50/p99,
socket MB/s, rescale batches and settle time.

## What the mock does

`server.mjs` serves `/gen-api/settings` and STOMP over a raw WebSocket at `/ws`, where each connection
is one client that subscribes to `/user/queue/blocks`.
Frames carry `content-length` the way Spring's encoder writes them. As with the real backend, each
`/client-update` is answered right away by one MESSAGE per added block, holding its FULL, and
every tick (`--tick`, default 250 ms) sends each client one MESSAGE with a BORDER for every block it
already has (empty if it has none). A client that asks for `sectors` gets SECTORs for the blocks in view
instead, in messages of 250 blocks: on a `/client-update`, and once every tick per 250 blocks in view, at least every 10 s. Block messages are binary frames (`application/octet-stream`) in
the layout documented in `src/app/features/world-of-cells/grid-view/block-frame.ts`. Every block exists, so there is
no NO_BLOCKS, and there are no heartbeats; the settings response carries no blocks, with `targetSpeed` set to `--tick`.
`--mbps` sends to each client at that many megabits per second, like a throttled link; 0, the default, sends at once.

The cells come from `recordings/world.bin`, a minute of world-of-cells.net recorded by `record.mjs`: 12×8
blocks around the viewport `/gen-api/settings` handed out, of which 61 existed, with each block's FULL and the 120
BORDERs that followed it. FULLs average 20 KB and BORDERs 0.2 KB. A block a client adds gets its recorded FULL,
then the recorded BORDERs in order, from the start again after 120 ticks. The recorded rectangle repeats across the
world, and blocks that didn't exist there are filled with ones that did. The settings send the recorded viewport and
blockSize, so the app starts where the recording was made. SECTORs aren't recorded; they are random at `--density`.
`node bench/record.mjs` overwrites the file with a fresh
recording; `--blocks`, `--generations`, `--url` and `--out` change what it records and where it writes.

`--pattern noise` serves random cells at `--density` (default 1/6) and `--block-size` instead, as the bench did
before 2026-11-16: a FULL is then about 365 KB. Each run stores its pattern (the recording's time, `noise` or `lines`),
and `--compare latest` only picks a baseline with the same one.

The STOMP client runs in a worker, so the page can't hook its socket directly. `server.mjs` prepends
`client/worker-hook.js` to every `worker-*.js` the build serves. In the worker that owns the socket,
the hook times the message handler (the `socket wkr ms` column) and tags what that worker posts, so
tick→draw latency still starts when the message arrives.

## When the drawing code changes

The hooks infer cellSize from `drawImage`'s destination width (= blockSize × cellSize). If drawing
moves to sub-block tiles, update that one line, which is marked in `client/bench.js`. If drawing
moves to an OffscreenCanvas in a worker, the main-thread hooks no longer see draws. The worker would
then need to report its frames, for example by posting them to the page.

Sectors are drawn into an OffscreenCanvas, which reaches the page in one `drawImage`. In sector mode, cellSize, srcMpx
and cover therefore describe that image, not the blocks, and zoom-min-bounce turns back as soon as it zooms in.
zoom-sectors counts wheel steps instead.

## Game of Life step (`bench/gol/`)

A separate, quicker check of the decode worker's `stepGameOfLife`, outside the app:

```sh
npm run bench:gol                                         # verify + time in Node, against b66d5cb
npm run bench:gol -- --browsers chrome,firefox,webkit     # also time it in each browser (headless)
npm run bench:gol -- --baseline HEAD --size 500           # any commit as the baseline, any block size
```

`run.mjs` bundles `decompress-block.worker.ts` twice, from the working tree and from the baseline
commit (via `git show`), and appends an export of `stepGameOfLife` to each. Verification steps random
blocks of sizes 3 to 2000 and densities 0 to 1 for many generations. The current version must match a
naive neighbour count on the inner cells, and must be byte-identical to the baseline once the border
is written, as the worker does. Timing is the median ms per generation of a 2000² block at density
1/6, with the two versions interleaved. The default baseline, b66d5cb, is the client's earlier
column-sum algorithm.

## FULL block decoding (`bench/full-block/`)

`node bench/full-block/run.mjs --data <dir>` checks `readStrips` on FULL blocks of real chaos hits and times it
against zstd of the rows, as the backend sent FULL blocks before strips. Add `--browsers chrome,firefox,webkit` to
time it in each browser too (headless). CellService's `FullBlockChaosTest` writes the blocks, both ways and per
age of the hit, with `-Dchaos.write=<dir>`; its Javadoc has the command.

## Socket frames (`bench/ws-frames.mjs`)

`node bench/ws-frames.mjs [base url] [extension offer]` connects like a browser does, subscribes to four
blocks and prints each message the backend sends: compressed or not, how many fragments, and its size.
Safari drops the connection on a binary message split into fragments once `permessage-deflate` is
negotiated, and Tomcat splits compressed messages into 8 KB fragments. The tool flags those messages.
The default offer is Safari's (`permessage-deflate`); pass `""` to see what an uncompressed connection gets.

## Reconnect

`node bench/reconnect.mjs` (after `npx ng build`) runs the build against the real backend on :8080 through
a proxy that can kill the `/ws` socket or turn it half-open, and optionally freezes the page as
"standby" or only hides it. It prints the time from wake to the first freshly decoded bitmap, plus a
timeline of socket opens/closes and `/gen-api` calls. `--scenarios kill,sleep3-halfopen,hidden15,...`,
`--headed`, `--backend <port>`.

## Draw calls (`bench/draw-calls.mjs`)

`node bench/draw-calls.mjs` opens `draw-calls.html` in each browser and redraws a screen of 16 px blocks every frame,
as sectors at the zoom limit are drawn: a drawImage per 40x40 bitmap, per slot of one atlas, or one image for the
whole view. `--blocks`, `--viewport`, `--dpr` and `--variants` change it. The page also runs on its own, e.g. on a phone.
