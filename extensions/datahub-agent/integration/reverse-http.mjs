import { createServer } from "node:net";
import { chmod } from "node:fs/promises";

/** Host-owned Unix listener. A runtime connects out through a read-only mount;
 * the host never opens a socket pathname that the runtime can replace. */
export async function createReverseHttpPool(
  socketPath,
  { capacity = 32, pendingLimit = 128 } = {},
) {
  if (
    Buffer.byteLength(socketPath) > 100 ||
    ![capacity, pendingLimit].every((n) => Number.isSafeInteger(n) && n > 0)
  ) {
    throw new Error("invalid_reverse_transport_configuration");
  }
  const sockets = new Set();
  const idle = new Map();
  const waiting = new Set();
  let closed = false;
  const server = createServer((socket) => {
    if (closed || sockets.size >= capacity) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      idle.delete(socket);
    });
    const waiter = waiting.values().next().value;
    if (waiter) waiter.finish(null, socket);
    else {
      // No request has been assigned. Any bytes/EOF are an unsolicited response
      // (e.g. the app's idle-header 408), not reusable transport capacity.
      const discard = () => socket.destroy();
      idle.set(socket, discard);
      socket.once("readable", discard);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    acquire(signal = AbortSignal.timeout(5000)) {
      if (closed || signal.aborted)
        return Promise.reject(new Error("runtime_transport_unavailable"));
      for (const [socket, discard] of idle) {
        idle.delete(socket);
        socket.off("readable", discard);
        if (socket.destroyed || socket.readableEnded || socket.readableLength) {
          socket.destroy();
          continue;
        }
        return Promise.resolve(socket);
      }
      if (waiting.size >= pendingLimit)
        return Promise.reject(
          new Error("runtime_transport_capacity_exhausted"),
        );
      return new Promise((resolve, reject) => {
        const waiter = {
          finish(error, socket) {
            waiting.delete(waiter);
            signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(socket);
          },
        };
        const abort = () =>
          waiter.finish(new Error("runtime_transport_unavailable"));
        waiting.add(waiter);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiting)
        waiter.finish(new Error("runtime_transport_unavailable"));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
