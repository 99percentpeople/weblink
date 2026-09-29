// CDP requests are bounded and rejected when the browser closes.
export async function connect(
  url,
  { timeoutMs = 10000 } = {},
) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP connection timeout")),
      5000,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP connection failed"));
    };
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(
        new Error(JSON.stringify(message.error)),
      );
    else request.resolve(message.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP connection closed"));
    }
    pending.clear();
  };
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(
          () => {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          },
          method === "Page.navigate"
            ? Math.max(30000, timeoutMs)
            : timeoutMs,
        );
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

export async function evaluate(client, expression) {
  const response = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      JSON.stringify(response.exceptionDetails),
    );
  return response.result.value;
}
