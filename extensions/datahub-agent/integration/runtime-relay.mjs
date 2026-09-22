import { connect, createServer } from "node:net";

/** Let both writable queues drain after EOF. Destroying a peer on the first
 * close truncates large HTTP/TLS responses under backpressure. */
export function bridgeSockets(left, right, onClose = () => {}) {
  left.allowHalfOpen = right.allowHalfOpen = true;
  let finished = false;
  const failed = () => {
    left.destroy();
    right.destroy();
  };
  const closed = (socket, peer) => {
    if (!socket.readableEnded || !socket.writableFinished) peer.destroy();
    if (!finished && left.destroyed && right.destroyed) {
      finished = true;
      onClose();
    }
  };
  left.on("error", failed);
  right.on("error", failed);
  left.on("close", () => closed(left, right));
  right.on("close", () => closed(right, left));
  left.pipe(right);
  right.pipe(left);
}

/** Run inside network-none. Raw HTTP/SSE bytes only, no custom RPC or identity. */
export function startRuntimeRelay({
  socketPath,
  port = 30141,
  capacity = 32,
  retryMs = 1000,
}) {
  if (
    typeof socketPath !== "string" ||
    !socketPath.startsWith("/") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 128 ||
    !Number.isInteger(retryMs) ||
    retryMs < 10
  )
    throw new Error("invalid_runtime_relay_configuration");
  let closed = false;
  const slots = Array.from({ length: capacity }, () => ({
    local: null,
    remote: null,
    timer: null,
  }));
  function start(slot) {
    if (closed) return;
    let ended = false;
    let linked = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      slot.local?.destroy();
      slot.remote?.destroy();
      if (!closed) slot.timer = setTimeout(() => start(slot), retryMs);
    };
    slot.local = connect({ host: "127.0.0.1", port });
    slot.local.on("error", finish);
    slot.local.on("close", () => {
      if (!linked) finish();
    });
    slot.local.once("connect", () => {
      if (closed || ended) {
        finish();
        return;
      }
      // A host-visible connection exists only after the local app is listening.
      slot.remote = connect(socketPath);
      slot.remote.on("error", finish);
      slot.remote.on("close", () => {
        if (!linked) finish();
      });
      slot.remote.once("connect", () => {
        if (closed || ended) {
          finish();
          return;
        }
        linked = true;
        bridgeSockets(slot.local, slot.remote, finish);
      });
    });
  }
  for (const slot of slots) start(slot);
  return () => {
    closed = true;
    for (const slot of slots) {
      clearTimeout(slot.timer);
      slot.local?.destroy();
      slot.remote?.destroy();
    }
  };
}

/** Standard HTTP(S)_PROXY endpoint on the runtime's isolated loopback only. */
export async function startLocalEgressRelay(socketPath, port = 3128) {
  const sockets = new Map();
  const server = createServer((client) => {
    if (sockets.size >= 32) {
      client.destroy();
      return;
    }
    const upstream = connect(socketPath);
    sockets.set(client, upstream);
    bridgeSockets(client, upstream, () => sockets.delete(client));
  });
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return async () => {
    for (const [client, upstream] of sockets) {
      client.destroy();
      upstream.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  };
}
