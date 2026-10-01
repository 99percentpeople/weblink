// Node 22+, Bun and Chromium. Uses the real app, signaling, RTC and IndexedDB.
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, evaluate } from "./browser-cdp.mjs";

const appRoot = fileURLToPath(
  new URL("../", import.meta.url),
);
const signalEntry = fileURLToPath(
  new URL(
    "../../../servers/weblink-ws-server/src/index.ts",
    import.meta.url,
  ),
);
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, check, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child) {
  if (
    !child?.pid ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    3000,
  );
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

const profile = await mkdtemp(
  join(tmpdir(), "weblink-messaging-"),
);
const clients = [];
let signaling, browser, vite, root;
let cleanupPromise;
let diagnostics = "";
const deadline = setTimeout(() => {
  console.error(
    "Messaging browser check exceeded three minutes",
  );
  void cleanup().finally(() => process.exit(1));
}, 180000);
function cleanup() {
  return (cleanupPromise ??= cleanupResources());
}
async function cleanupResources() {
  for (const client of clients) client.close();
  try {
    await root?.call("Browser.close");
  } catch {
    /* Browser may have exited. */
  }
  root?.close();
  await Promise.allSettled([
    stop(browser),
    stop(signaling),
    vite?.close(),
  ]);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
try {
  // A temporary working directory and explicit environment keep local .env,
  // Redis and deployed services out of this test.
  let signalPort;
  let signalError;
  signaling = spawn(
    process.env.BUN_PATH ?? "bun",
    [signalEntry],
    {
      cwd: profile,
      env: {
        PATH: process.env.PATH,
        HOSTNAME: "127.0.0.1",
        PORT: "0",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  signaling.on("error", (error) => {
    signalError = error;
  });
  let lines = "";
  signaling.stdout.on("data", (data) => {
    lines += data;
    const complete = lines.split("\n");
    lines = complete.pop();
    for (const line of complete) {
      try {
        const entry = JSON.parse(line);
        if (entry.msg === "WebSocket server started")
          signalPort = entry.port;
      } catch {
        /* Partial diagnostic output is not a readiness signal. */
      }
    }
  });
  signaling.stderr.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-8000);
  });
  await until(
    "local signaling",
    () => {
      if (signalError) throw signalError;
      if (signaling.exitCode !== null)
        throw new Error(`Signaling exited: ${diagnostics}`);
      return signalPort;
    },
    10000,
  );

  process.chdir(appRoot); // The app's Vite config reads its package metadata.
  process.env.WEBLINK_WEBSOCKET_URL = `ws://127.0.0.1:${signalPort}`;
  vite = await createServer({
    root: appRoot,
    envDir: profile,
    cacheDir: join(profile, "vite-cache"),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
    },
    define: {
      "import.meta.env.WEBLINK_STUN_SERVERS":
        JSON.stringify(""),
      "import.meta.env.VITE_TURN_SERVERS":
        JSON.stringify(""),
    },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  let browserError;
  browser = spawn(
    process.env.CHROMIUM_PATH ?? "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  browser.on("error", (error) => {
    browserError = error;
  });
  browser.stderr.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-8000);
  });
  const port = await until(
    "Chromium debugger",
    async () => {
      if (browserError) throw browserError;
      if (
        browser.exitCode !== null ||
        browser.signalCode !== null
      )
        throw new Error(`Chromium exited: ${diagnostics}`);
      try {
        return +(
          await readFile(
            join(profile, "DevToolsActivePort"),
            "utf8",
          )
        ).split("\n")[0];
      } catch {
        return false;
      }
    },
    30000,
  );
  root = await connect(
    (
      await (
        await fetch(`http://127.0.0.1:${port}/json/version`)
      ).json()
    ).webSocketDebuggerUrl,
  );
  const ids = [0, 1].map(
    () =>
      `uid_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
  );
  const room = `messaging-${crypto.randomUUID()}`;
  const conversation = `direct:${JSON.stringify([...ids].sort())}`;
  for (let i = 0; i < 2; i++) {
    const { browserContextId } = await root.call(
      "Target.createBrowserContext",
    );
    const { targetId } = await root.call(
      "Target.createTarget",
      { url: "about:blank", browserContextId },
    );
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    const client = await connect(
      targets.find((target) => target.id === targetId)
        .webSocketDebuggerUrl,
      { timeoutMs: 30000 },
    );
    clients.push(client);
    await client.call("Page.enable");
    const user = {
      clientId: ids[i],
      name: `Browser ${i}`,
      avatar: null,
      roomId: room,
      password: null,
      autoJoin: true,
      initalJoin: false,
    };
    await client.call(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `
      localStorage.setItem('app_initialized','true');
      localStorage.setItem('starter_message_sent','true');
      localStorage.setItem('profile',${JSON.stringify(JSON.stringify(user))});
      window.__downloadFiles = {};
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function(blob) {
        if (blob instanceof File && blob.name.startsWith('messaging-')) window.__downloadFiles[blob.name] = blob;
        return create(blob);
      };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        if (this.download.startsWith('messaging-')) return;
        return click.call(this);
      };
    `,
      },
    );
    await client.call("Page.navigate", {
      url: `${origin}/?panel=chat&conversation=${encodeURIComponent(conversation)}`,
    });
  }

  const ready = () =>
    until("both private composers ready", async () => {
      try {
        return (
          await Promise.all(
            clients.map((client) =>
              evaluate(
                client,
                `Boolean(!window.__messagingReloadPending && document.querySelector('textarea') && !document.querySelector('textarea').disabled)`,
              ),
            ),
          )
        ).every(Boolean);
      } catch (error) {
        // Reload destroys the previous execution context before the next one is ready.
        if (
          /Inspected target navigated|Execution context was destroyed|Cannot find context/.test(
            String(error),
          )
        )
          return false;
        throw error;
      }
    });
  const snapshots = () =>
    Promise.all(
      clients.map((client) =>
        evaluate(
          client,
          `new Promise((resolve, reject) => {
    const open = indexedDB.open('message_store'); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction(['messages','conversations']);
      const messages = transaction.objectStore('messages').getAll();
      const conversations = transaction.objectStore('conversations').getAll();
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.oncomplete = () => { db.close(); resolve({ messages: messages.result, conversations: conversations.result,
        draft: document.querySelector('textarea')?.value,
        errors: [...document.querySelectorAll('[data-sonner-toast][data-type="error"]')].map(e => e.innerText) }); };
    };
  })`,
        ),
      ),
    );
  await ready();
  const initial = await snapshots();
  if (!initial.every((s) => s.messages.length === 0))
    throw new Error(
      "Test did not start with empty history",
    );

  for (let round = 0; round < 2; round++) {
    if (round) {
      await Promise.all(
        clients.map((client) =>
          evaluate(
            client,
            "window.__messagingReloadPending = true",
          ),
        ),
      );
      await Promise.all(
        clients.map((client) => client.call("Page.reload")),
      );
      await ready();
      const restored = await snapshots();
      if (!restored.every((s) => s.messages.length === 4))
        throw new Error("Reload lost private history");
    }
    for (let i = 0; i < 2; i++)
      await evaluate(
        clients[i],
        `(() => {
      const textarea = document.querySelector('textarea');
      textarea.value = 'messaging-text-${round}-${i}';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      const data = new DataTransfer();
      data.items.add(new File(['messaging-bytes-${round}-${i}|'.repeat(8192)], 'messaging-${round}-${i}.txt', { type: 'text/plain' }));
      document.querySelector('[data-slot="chat-page"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    })()`,
      );
    let latest;
    try {
      await until(
        `round ${round}: acknowledged text and complete files`,
        async () => {
          latest = await snapshots();
          return latest.every(
            (s) =>
              s.messages.length === 4 * (round + 1) &&
              s.draft === "" &&
              s.errors.length === 0 &&
              s.messages.every(
                (m) =>
                  m.status === "received" &&
                  (m.type !== "file" ||
                    m.transferStatus === "complete"),
              ),
          );
        },
      );
    } catch (error) {
      console.error(JSON.stringify(latest));
      throw error;
    }
    if (
      !latest.every((s) =>
        s.conversations.some(
          (c) =>
            c.id === conversation &&
            c.roomConversationIds?.length,
        ),
      )
    )
      throw new Error(
        "Connected private conversation did not retain room membership",
      );
    const expectedTexts = Array.from(
      { length: round + 1 },
      (_, n) =>
        [0, 1].map((peer) => `messaging-text-${n}-${peer}`),
    )
      .flat()
      .sort();
    if (
      !latest.every(
        (s) =>
          s.messages.every(
            (message) =>
              message.conversationId === conversation,
          ) &&
          JSON.stringify(
            s.messages
              .filter((message) => message.type === "text")
              .map((message) => message.data)
              .sort(),
          ) === JSON.stringify(expectedTexts),
      )
    )
      throw new Error(
        "Private text contents or conversation identity changed",
      );
    for (let i = 0; i < 2; i++) {
      const verified = await evaluate(
        clients[i],
        `(async () => {
        const name = 'messaging-${round}-${1 - i}.txt';
        const title = [...document.querySelectorAll('[data-slot="file-attachment-bubble"] [title]')].find(e => e.title === name);
        const download = title?.closest('[data-slot="file-attachment-bubble"]')?.querySelector('button[aria-label="Download"]');
        if (!download) throw new Error('Received file download unavailable');
        download.click();
        const file = window.__downloadFiles[name];
        return !!file && (await file.text()) === 'messaging-bytes-${round}-${1 - i}|'.repeat(8192);
      })()`,
      );
      if (!verified)
        throw new Error("Downloaded file content mismatch");
    }
    console.log(
      `Passed: ${round ? "restored history" : "empty history"}, bidirectional text, files, ACKs and downloaded bytes`,
    );
  }
} catch (error) {
  console.error(error);
  for (const client of clients) {
    try {
      console.error(
        await evaluate(client, "document.body.innerText"),
      );
    } catch {
      /* Browser may have exited. */
    }
  }
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await cleanup();
}
