// Prepended to the app's worker scripts by bench/server.mjs. In the worker that owns the STOMP socket
// it times each socket message handler (the stompjs parse plus the split per decode worker), reports
// that to the page over a BroadcastChannel, and tags whatever the worker posts during the handler with
// the message's arrival time, so the page can measure socket -> screen latency. Other workers are untouched.
(() => {
  if (typeof WebSocket === 'undefined' || self.__cellwebBenchHook) return;
  self.__cellwebBenchHook = true;
  const channel = new BroadcastChannel('cellweb-bench');
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  let arrivedAt = null; // performance.timeOrigin-based ms while a socket handler runs

  class BenchWebSocket extends WebSocket {}
  if (descriptor) Object.defineProperty(BenchWebSocket.prototype, 'onmessage', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(fn) {
      descriptor.set.call(this, typeof fn !== 'function' ? fn : function (event) {
        const t0 = performance.now();
        arrivedAt = performance.timeOrigin + t0;
        try {
          return fn.call(this, event);
        } finally {
          const bytes = typeof event.data === 'string' ? event.data.length : event.data.byteLength;
          channel.postMessage({kind: 'socket', at: arrivedAt, bytes, ms: performance.now() - t0});
          arrivedAt = null;
        }
      });
    },
  });
  self.WebSocket = BenchWebSocket;

  const post = self.postMessage.bind(self);
  self.postMessage = function (message, ...rest) {
    if (arrivedAt !== null && message && typeof message === 'object' && !Array.isArray(message)) message.__benchSocketAt = arrivedAt;
    return post(message, ...rest);
  };
})();
