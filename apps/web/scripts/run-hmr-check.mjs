// Bun/Node 22+, Chromium and rsync. Test copies keep the working tree unchanged.
import { createServer } from "vite";
import { connect, evaluate } from "./browser-cdp.mjs";
import {
  rsyncArgs,
  syncFilter,
} from "../../../scripts/sync.mjs";
import { spawn, execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const webRoot = fileURLToPath(
    new URL("../", import.meta.url),
  ),
  repo = resolve(webRoot, "../..");
const initialCwd = process.cwd();
const previousSignaling = process.env.WEBLINK_WEBSOCKET_URL;
const temp = await mkdtemp(
  join(tmpdir(), "weblink-actual-hmr-"),
);
const source = join(temp, "source"),
  receiver = join(temp, "receiver"),
  profile = join(temp, "chrome");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = String(e);
    }
    await sleep(100);
  }
  throw new Error(
    label + " timeout: " + JSON.stringify(last),
  );
}
async function unusedPort() {
  const s = netServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
let signaling, browser, browserCdp;
const clients = [],
  servers = [];
try {
  await mkdir(source);
  await mkdir(receiver);
  await mkdir(profile);
  await cp(join(webRoot, "src"), join(source, "src"), {
    recursive: true,
  });
  await cp(join(webRoot, "src"), join(receiver, "src"), {
    recursive: true,
  });
  for (const file of ["package.json", "index.html"])
    await cp(join(webRoot, file), join(receiver, file));
  await cp(
    join(webRoot, "public"),
    join(receiver, "public"),
    { recursive: true },
  );
  await symlink(
    join(webRoot, "node_modules"),
    join(receiver, "node_modules"),
  );
  await cp(join(repo, "bun.lock"), join(temp, "bun.lock"));
  const composition = join(
    source,
    "src/libs/state/application-root.ts",
  );
  let rootCode = await readFile(composition, "utf8");
  rootCode =
    `import {appState} from './app-state';\nimport {sessionService} from '@/libs/application/session-service';\n` +
    rootCode;
  rootCode = rootCode.replace(
    "const dialogs = createAppDialogs();",
    `const dialogs = createAppDialogs();\n(globalThis as any).__hmr={state,audio,media,meeting,dialogs,appState,sessionService};`,
  );
  assert(rootCode.includes("__hmr={"));
  await writeFile(composition, rootCode);
  await writeFile(
    join(receiver, "src/libs/state/application-root.ts"),
    rootCode,
  );
  let boot = await readFile(
    join(receiver, "src/bootstrap.ts"),
    "utf8",
  );
  boot = boot.replace(
    "  mountApplication(root);",
    "  (globalThis as any).__unmount = mountApplication(root);",
  );
  await writeFile(join(receiver, "src/bootstrap.ts"), boot);
  const filter = join(temp, "filter");
  async function transfer(files) {
    await writeFile(filter, syncFilter(files, []));
    execFileSync(
      "rsync",
      rsyncArgs(
        source,
        receiver + "/",
        join(temp, "backup"),
        filter,
      ),
      { stdio: "pipe" },
    );
  }
  const signalPort = await unusedPort();
  signaling = spawn("bun", ["./src/index.ts"], {
    cwd: join(repo, "servers/weblink-ws-server"),
    env: {
      ...process.env,
      PORT: String(signalPort),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      LOG_LEVEL: "error",
      REDIS_URL: "",
      TLS_CERT_FILE: "",
      TLS_KEY_FILE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let signalLog = "";
  signaling.stdout.on("data", (d) => (signalLog += d));
  signaling.stderr.on("data", (d) => (signalLog += d));
  await until(async () => {
    if (signaling.exitCode !== null)
      throw new Error(signalLog);
    try {
      return (
        await fetch(
          `http://127.0.0.1:${signalPort}/healthcheck`,
        )
      ).ok;
    } catch {
      return false;
    }
  }, "signaling");
  process.env.WEBLINK_WEBSOCKET_URL = `ws://127.0.0.1:${signalPort}`;
  process.chdir(webRoot);
  for (const mode of ["development", "desktop"]) {
    const server = await createServer({
      root: receiver,
      configFile: join(webRoot, "vite.config.ts"),
      mode,
      logLevel: "warn",
      cacheDir: join(temp, "cache", mode),
      resolve: { alias: { "@": join(receiver, "src") } },
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        fs: { allow: [temp, repo] },
      },
    });
    await server.listen();
    servers.push(server);
  }
  process.chdir(repo);
  assert.notEqual(
    servers[0].config.cacheDir,
    servers[1].config.cacheDir,
  );
  browser = spawn(
    process.env.CHROMIUM_PATH || "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const active = await until(async () => {
    try {
      return (
        await readFile(
          join(profile, "DevToolsActivePort"),
          "utf8",
        )
      ).split("\n");
    } catch {
      return false;
    }
  }, "browser");
  const debugPort = active[0];
  browserCdp = await connect(
    `ws://127.0.0.1:${debugPort}${active[1]}`,
    { timeoutMs: 15000 },
  );
  const room = "hmr-" + Date.now(),
    url = `http://127.0.0.1:${servers[0].httpServer.address().port}/`;
  for (let i = 0; i < 2; i++) {
    const { browserContextId } = await browserCdp.call(
      "Target.createBrowserContext",
    );
    const { targetId } = await browserCdp.call(
      "Target.createTarget",
      { url: "about:blank", browserContextId },
    );
    const target = await until(
      async () =>
        (
          await (
            await fetch(
              `http://127.0.0.1:${debugPort}/json/list`,
            )
          ).json()
        ).find((t) => t.id === targetId),
      "tab",
    );
    const client = await connect(
      target.webSocketDebuggerUrl,
      { timeoutMs: 45000 },
    );
    clients.push(client);
    await client.call("Page.enable");
    await client.call(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `window.__errors=JSON.parse(sessionStorage.getItem('errors')||'[]');const save=e=>{window.__errors.push(e);sessionStorage.setItem('errors',JSON.stringify(window.__errors));};window.addEventListener('error',e=>save(e.error?.stack||e.message));window.addEventListener('unhandledrejection',e=>save(e.reason?.stack||String(e.reason)));localStorage.setItem('app_initialized','true');localStorage.setItem('starter_message_sent','true');localStorage.setItem('profile',JSON.stringify({clientId:'uid_hmr_'+${i},roomId:${JSON.stringify(room)},name:'HMR '+${i},password:null,avatar:null,autoJoin:false,initalJoin:false}));`,
      },
    );
    await client.call("Page.navigate", { url });
    await until(
      () =>
        evaluate(
          client,
          '!!window.__hmr && !!document.querySelector("audio")',
        ),
      "application " + i,
    );
    console.log(
      "mounted",
      i,
      await evaluate(
        client,
        "({errors:window.__errors,body:document.body.innerText.slice(0,100)})",
      ),
    );
    await evaluate(client, "window.__hmr.state.joinRoom()");
    await evaluate(
      client,
      "window.__hmr.media.media.toggleMicrophone()",
    );
    await evaluate(
      client,
      "window.__hmr.media.media.toggleCamera()",
    );
    await until(
      () =>
        evaluate(
          client,
          '!!document.querySelector("main") && !!document.querySelector("video")',
        ),
      "meeting view " + i,
    );
  }
  await until(
    () =>
      evaluate(
        clients[0],
        `Object.values(window.__hmr.sessionService.sessions).some(s=>s.peerConnection?.connectionState==='connected')`,
      ),
    "peer connected",
  );
  for (const client of clients) {
    await evaluate(
      client,
      `window.__before={runtime:window.__hmr,document:performance.timeOrigin,stream:window.__hmr.state.localStream(),peer:Object.values(window.__hmr.sessionService.sessions)[0]?.peerConnection};window.__ended=0;window.__before.stream.getTracks().forEach(t=>t.addEventListener('ended',()=>window.__ended++));`,
    );
  }
  async function snapshot(client) {
    return evaluate(
      client,
      `({view:!!document.querySelector('main') && !!document.querySelector('video'),sameDocument:performance.timeOrigin===window.__before?.document,sameRuntime:window.__hmr===window.__before?.runtime,sameStream:window.__hmr.state.localStream()===window.__before?.stream,samePeer:Object.values(window.__hmr.sessionService.sessions)[0]?.peerConnection===window.__before?.peer,connection:Object.values(window.__hmr.sessionService.sessions)[0]?.peerConnection?.connectionState,room:window.__hmr.appState.roomStatus.roomId,live:window.__hmr.state.localStream()?.getTracks().every(t=>t.readyState==='live'),ended:window.__ended,revision:window.__viewRevision,errors:window.__errors})`,
    );
  }
  const edits = [
    "src/routes/home/index.tsx",
    "src/app.tsx",
    "src/components/app/audio-player.tsx",
    "src/components/app/meeting-session-provider.tsx",
    "src/routes/home/components/video-display.tsx",
    "src/routes/home/components/meeting-tile-actions.tsx",
  ];
  const original = {};
  for (const file of edits)
    original[file] = await readFile(
      join(source, file),
      "utf8",
    );
  for (let iteration = 1; iteration <= 3; iteration++) {
    for (const file of edits)
      await writeFile(
        join(source, file),
        original[file] +
          `\n// rsync HMR ${iteration}\n` +
          (file === edits[0]
            ? `(globalThis as any).__viewRevision=${iteration};\n`
            : ""),
      );
    await transfer(edits);
    for (const client of clients)
      await until(
        () =>
          evaluate(
            client,
            `window.__viewRevision === ${iteration}`,
          ),
        `view revision ${iteration}`,
      );
    for (const client of clients) {
      const state = await snapshot(client);
      console.log("batch", iteration, state);
      assert(
        state.view &&
          state.sameDocument &&
          state.sameRuntime &&
          state.sameStream &&
          state.samePeer &&
          state.live,
      );
      assert.equal(state.connection, "connected");
      assert.equal(state.room, room);
      assert.equal(state.ended, 0);
      assert.equal(state.revision, iteration);
      assert.deepEqual(state.errors, []);
    }
  }
  for (const client of clients)
    assert(
      await evaluate(
        client,
        "Object.values(window.__hmr.sessionService.sessions).every(s=>s.isMessageChannelReady)",
      ),
    );
  const rtp = await evaluate(
    clients[0],
    `(async()=>{const pc=window.__before.peer;const bytes=async()=>[...(await pc.getStats()).values()].filter(s=>s.type==='outbound-rtp').reduce((n,s)=>n+(s.bytesSent||0),0);const before=await bytes();await new Promise(r=>setTimeout(r,500));return {before,after:await bytes()};})()`,
  );
  assert(rtp.after > rtp.before);
  console.log("RTP", rtp);
  // Contract and UI arrive in the same rsync batch. Native bootstrap propagation reloads safely.
  const definitions = [
    "src/libs/state/meeting-session-context.ts",
    "src/routes/home/components/video-display-scope.ts",
  ];
  for (const file of edits)
    await writeFile(
      join(source, file),
      original[file] +
        "\n// simultaneous contract and view revision\n" +
        (file === edits[0]
          ? "(globalThis as any).__viewRevision=4;\n"
          : ""),
    );
  for (const file of definitions) {
    const old = await readFile(join(source, file), "utf8");
    await writeFile(
      join(source, file),
      old + "\n// contract revision\n",
    );
  }
  await transfer([...definitions, ...edits]);
  for (const client of clients) {
    await until(
      () =>
        evaluate(
          client,
          '!!window.__hmr && !window.__before && !!document.querySelector("main") && window.__viewRevision===4',
        ),
      "native reload",
    );
    assert.deepEqual(
      await evaluate(client, "window.__errors"),
      [],
    );
  }
  console.log(
    "PASS: actual application survived three simultaneous view batches; runtime, capture and connected peers retained; RTP continued; context batch rebuilt natively.",
  );
  // Rejoin in the rebuilt runtime, then explicitly dispose once and verify cleanup.
  const client = clients[0];
  await evaluate(client, "window.__hmr.state.joinRoom()");
  await evaluate(
    client,
    "window.__hmr.media.media.toggleMicrophone()",
  );
  const cleanup = await evaluate(
    client,
    `(()=>{const stream=window.__hmr.state.localStream();const tracks=stream.getTracks();let calls=0;for(const track of tracks){const stop=track.stop.bind(track);track.stop=()=>{calls++;stop();};}window.__unmount();return {calls,tracks:tracks.length,ended:tracks.every(t=>t.readyState==='ended'),status:window.__hmr.appState.session.clientServiceStatus,audio:document.querySelector('audio')};})()`,
  );
  console.log("cleanup", cleanup);
  assert.equal(cleanup.calls, cleanup.tracks);
  assert(cleanup.ended);
  assert.equal(cleanup.status, "disconnected");
  assert.equal(cleanup.audio, null);
} finally {
  process.chdir(initialCwd);
  if (previousSignaling === undefined)
    delete process.env.WEBLINK_WEBSOCKET_URL;
  else
    process.env.WEBLINK_WEBSOCKET_URL = previousSignaling;
  for (const client of clients) client.close();
  browserCdp?.close();
  for (const child of [browser, signaling])
    if (
      child &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      const stopped = new Promise((r) =>
        child.once("exit", r),
      );
      child.kill("SIGTERM");
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        3000,
      );
      try {
        await stopped;
      } finally {
        clearTimeout(timer);
      }
    }
  for (const server of servers) await server.close();
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
