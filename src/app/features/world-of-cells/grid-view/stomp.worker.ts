import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {Subscription} from 'rxjs';
import {readBlockFrame} from './block-frame';
import {workerIndex} from './utils.component';

export type SocketCommand =
  | {type: 'activate'; brokerURL: string}
  | {type: 'subscribe'; clientId: string; workers: number}
  | {type: 'unsubscribe'}
  | {type: 'publish'; destination: string; body: string}
  | {type: 'renew'}
  | {type: 'deactivate'};

export type SocketEvent =
  | {type: 'connected'}
  | {type: 'blocks'; clientId: string; perWorker: (ArrayBuffer | null)[]}
  | {type: 'healthAck'; clientId: string}
  | {type: 'sessionDead'; clientId: string};

let stomp: RxStomp | undefined;
let subscription: Subscription | undefined;

globalThis.onmessage = (e: MessageEvent<SocketCommand>) => {
  const command = e.data;
  switch (command.type) {
    case 'activate':
      stomp = new RxStomp();
      stomp.configure({brokerURL: command.brokerURL, connectHeaders: {}, reconnectDelay: 500, discardWebsocketOnCommFailure: true});
      stomp.connected$.subscribe(() => post({type: 'connected'}));
      stomp.activate();
      break;
    case 'subscribe':
      subscription?.unsubscribe();
      subscription = stomp!
        .watch('/topic/' + command.clientId)
        .subscribe((message) => onMessage(message, command.clientId, command.workers));
      break;
    case 'unsubscribe':
      subscription?.unsubscribe();
      subscription = undefined;
      break;
    case 'publish':
      stomp?.publish({destination: command.destination, body: command.body});
      break;
    case 'renew':
      // Drops the socket at once, without a closing handshake, and reconnects.
      stomp?.stompClient.forceDisconnect();
      break;
    case 'deactivate':
      subscription?.unsubscribe();
      void stomp?.deactivate().then(() => self.close());
      break;
  }
};

function post(event: SocketEvent, transfer: ArrayBuffer[] = []): void {
  self.postMessage(event, {transfer});
}

function onMessage(message: IMessage, clientId: string, workers: number): void {
  if (message.headers['content-type']?.startsWith('application/octet-stream')) {
    let perWorker: (ArrayBuffer | null)[];
    try {
      perWorker = splitByWorker(message.binaryBody, workers);
    } catch (e) {
      console.error('Dropping malformed block message', e);
      return;
    }
    post({type: 'blocks', clientId, perWorker}, perWorker.filter((b): b is ArrayBuffer => b !== null));
    return;
  }

  const body = JSON.parse(message.body);
  if (body?.type === 'HEALTH_ACK') {
    post({type: 'healthAck', clientId});
  } else if (body?.type === 'SESSION_DEAD') {
    post({type: 'sessionDead', clientId});
  } else {
    console.warn('Unexpected message on the block topic', body);
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
