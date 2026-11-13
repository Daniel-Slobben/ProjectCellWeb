import {IMessage, ReconnectionTimeMode, RxStomp} from '@stomp/rx-stomp';
import {readBlockFrame} from './block-frame';
import {workerIndex} from './utils.component';

export type SocketCommand =
  | {type: 'activate'; brokerURL: string; workers: number}
  | {type: 'publish'; destination: string; body: string}
  | {type: 'deactivate'};

export type SocketEvent =
  | {type: 'connected'}
  | {type: 'blocks'; perWorker: (ArrayBuffer | null)[]}
  | {type: 'noBlocks'};

let stomp: RxStomp | undefined;
let workers = 1;

globalThis.onmessage = (e: MessageEvent<SocketCommand>) => {
  const command = e.data;
  switch (command.type) {
    case 'activate':
      workers = command.workers;
      stomp ??= createStomp(command.brokerURL);
      stomp.activate();
      break;
    case 'publish':
      // Dropped while disconnected: every new connection sends the whole block list again.
      if (stomp?.connected()) stomp.publish({destination: command.destination, body: command.body});
      break;
    case 'deactivate':
      // Without a closing handshake, which a dead socket would never finish.
      void stomp?.deactivate({force: true});
      break;
  }
};

function createStomp(brokerURL: string): RxStomp {
  const rxStomp = new RxStomp();
  // A socket that stops passing data without closing, as after a phone's standby, is dropped after 2 × 2 s without a
  // message. Ticks come far more often than that, so the server's heartbeats only cover a session without blocks.
  // Retries wait 0.5 s, doubling up to 8 s, so a restarting server isn't flooded by every client at once.
  rxStomp.configure({
    brokerURL, heartbeatIncoming: 2000, heartbeatOutgoing: 5000, connectionTimeout: 5000,
    reconnectDelay: 500, reconnectTimeMode: ReconnectionTimeMode.EXPONENTIAL, maxReconnectDelay: 8000,
    discardWebsocketOnCommFailure: true,
  });
  rxStomp.connected$.subscribe(() => post({type: 'connected'}));
  // The server routes this to our own session; RxStomp subscribes again on every new connection.
  rxStomp.watch('/user/queue/blocks').subscribe(onMessage);
  return rxStomp;
}

function post(event: SocketEvent, transfer: ArrayBuffer[] = []): void {
  self.postMessage(event, {transfer});
}

function onMessage(message: IMessage): void {
  if (message.headers['content-type']?.startsWith('application/octet-stream')) {
    let perWorker: (ArrayBuffer | null)[];
    try {
      perWorker = splitByWorker(message.binaryBody, workers);
    } catch (e) {
      console.error('Dropping malformed block message', e);
      return;
    }
    post({type: 'blocks', perWorker}, perWorker.filter((b): b is ArrayBuffer => b !== null));
    return;
  }

  const body = JSON.parse(message.body);
  if (body?.type === 'NO_BLOCKS') {
    post({type: 'noBlocks'});
  } else {
    console.warn('Unexpected message on the block queue', body);
  }
}

function splitByWorker(frame: Uint8Array, workers: number): (ArrayBuffer | null)[] {
  const blocks = readBlockFrame(frame);
  const owners = blocks.map((b) => workerIndex(b.x, b.y, workers));
  const sizes = new Array<number>(workers).fill(0);
  blocks.forEach((b, i) => sizes[owners[i]] += b.end - b.start);

  const buffers = sizes.map((size) => (size > 0 ? new Uint8Array(size) : null));
  const offsets = new Array<number>(workers).fill(0);
  blocks.forEach((b, i) => {
    const owner = owners[i];
    buffers[owner]!.set(frame.subarray(b.start, b.end), offsets[owner]);
    offsets[owner] += b.end - b.start;
  });
  return buffers.map((b) => (b ? b.buffer : null));
}
