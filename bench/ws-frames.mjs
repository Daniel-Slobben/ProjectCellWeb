// Prints the WebSocket frames a CellWeb backend sends, as a browser with a given compression offer would
// receive them: the negotiated extension, then FIN / RSV1 (compressed) / opcode / length per frame.
//
//   node bench/ws-frames.mjs [base url] [extension offer]
//   node bench/ws-frames.mjs https://world-of-cells.net                   # offers permessage-deflate, like Safari
//   node bench/ws-frames.mjs http://localhost:4200 ""                     # no offer: what you get with compression off
//
// Safari (WebKit) drops the connection (1006, "The network connection was lost") on a binary message split
// into fragments (FIN=0 then continuation frames) once permessage-deflate is negotiated. Tomcat fragments
// compressed messages at 8192 bytes. So with compression negotiated, any "binary ... fragments" line
// below means Safari will disconnect.
//
// It fetches /gen-api/settings for a client id, connects to /ws, sends CONNECT, SUBSCRIBE and a
// /client-update for four blocks, and listens for 2.5 s.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const base = new URL(process.argv[2] ?? 'https://world-of-cells.net');
const offer = process.argv[3] ?? 'permessage-deflate';
const {clientId} = await (await fetch(new URL('/gen-api/settings', base))).json();

const secure = base.protocol === 'https:';
const port = Number(base.port) || (secure ? 443 : 80);
const socket = secure
  ? tls.connect({host: base.hostname, port, servername: base.hostname, ALPNProtocols: ['http/1.1']})
  : net.connect({host: base.hostname, port});
socket.write(`GET /ws HTTP/1.1\r\nHost: ${base.host}\r\nOrigin: ${base.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
  `Sec-WebSocket-Protocol: v12.stomp, v11.stomp, v10.stomp\r\n` + (offer ? `Sec-WebSocket-Extensions: ${offer}\r\n` : '') + '\r\n');

function sendText(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  socket.write(Buffer.concat([head, mask, payload.map((b, i) => b ^ mask[i & 3])]));
}

let buffer = Buffer.alloc(0);
let upgraded = false, frames = 0, fragmentedBinary = 0, compressed = false;
let message = {opcode: 0, rsv1: 0, frames: 0, bytes: 0};
socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const head = buffer.subarray(0, end).toString().split('\r\n');
    const extension = head.find((l) => /^sec-websocket-extensions:/i.test(l));
    compressed = !!extension;
    console.log(`${head[0]}   ${extension ?? 'no extension negotiated'}`);
    buffer = buffer.subarray(end + 4);
    upgraded = true;
    sendText('CONNECT\naccept-version:1.2,1.1,1.0\nheart-beat:0,0\n\n\0');
  }
  while (buffer.length >= 2) {
    const fin = buffer[0] >> 7, rsv1 = (buffer[0] >> 6) & 1, opcode = buffer[0] & 15;
    let length = buffer[1] & 127, offset = 2;
    if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    if (buffer.length < offset + length) return;
    const payload = buffer.subarray(offset, offset + length);
    buffer = buffer.subarray(offset + length);
    frames++;
    if (opcode !== 0) message = {opcode, rsv1, frames: 0, bytes: 0, first: payload};
    message.frames++;
    message.bytes += length;
    if (!fin) continue;
    const kind = {1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong'}[message.opcode] ?? `opcode ${message.opcode}`;
    const shape = message.frames > 1 ? `${message.frames} fragments` : '1 frame';
    if (message.opcode === 2 && message.frames > 1) fragmentedBinary++;
    console.log(`${kind.padEnd(6)} ${message.rsv1 ? 'compressed  ' : 'uncompressed'} ${shape.padEnd(12)} ${message.bytes} B` +
      (message.opcode === 2 && message.frames > 1 && compressed ? '   <- Safari disconnects here' : '') +
      // Uncompressed text is readable: show the STOMP command and body, which tells an ERROR or a JSON event apart.
      (message.opcode === 1 && !message.rsv1 ? `   ${JSON.stringify(message.first.toString().replace(/\0$/, '').slice(0, 160))}` : ''));
    // CONNECTED is the first text message; compressed or not, it is short, so the subscribe can follow it.
    if (message.opcode === 1 && message.frames === 1 && message.bytes < 200 && frames === 1) {
      sendText(`SUBSCRIBE\nid:sub-0\ndestination:/topic/${clientId}\n\n\0`);
      const update = JSON.stringify({client: clientId, blocksToRemove: [], blocksToAdd: ['0/0', '1/0', '0/1', '1/1']});
      sendText(`SEND\ndestination:/client-update\ncontent-type:application/json\ncontent-length:${Buffer.byteLength(update)}\n\n${update}\0`);
    }
  }
});
socket.on('error', (e) => console.log(`socket error: ${e.message}`));
setTimeout(() => {
  console.log(`${frames} frames in 2.5 s; ${fragmentedBinary} fragmented binary message(s)` +
    (fragmentedBinary && compressed ? ': Safari would disconnect' : ''));
  socket.destroy();
  process.exit(0);
}, 2500);
