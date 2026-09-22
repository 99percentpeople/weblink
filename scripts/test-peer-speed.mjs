#!/usr/bin/env bun
// Run with Bun: built-in WebSocket, no browser automation dependency required.
import { createServer } from "vite";
import solidPlugin from "vite-plugin-solid";
import solidSvg from "vite-plugin-solid-svg";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const taskUi = process.argv.includes("--tasks");
const protocolTest = process.argv.includes("--protocol");
const transferTest = process.argv.includes("--transfer");
const cacheBenchmark = process.argv.includes(
  "--cache-benchmark",
);
const cacheTest = process.argv.includes("--cache");
const entry = cacheBenchmark
  ? "test/browser/cache-merge-benchmark.html"
  : cacheTest
    ? "test/browser/cache-merge.html"
    : taskUi
      ? "test/browser/task-center.html"
      : protocolTest
        ? "test/browser/rtc-protocol.html"
        : transferTest
          ? "test/browser/transfer-workflow.html"
          : "test/browser/speed-test.html";
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url) {
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
          method === "Page.navigate" ? 30000 : 10000,
        );
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function main() {
  const profile = await mkdtemp(
    join(tmpdir(), "weblink-speed-test-"),
  );
  let vite;
  let browser;
  let cdp;
  let browserError;
  let browserLog = "";
  try {
    // Avoid the application backend, HMR reruns and changes to a real profile.
    vite = await createServer({
      root,
      configFile: false,
      logLevel: "error",
      plugins: taskUi
        ? [solidPlugin(), solidSvg(), tailwindcss()]
        : [],
      resolve: {
        conditions: ["browser", "development"],
        alias: [
          ...(taskUi
            ? [
                {
                  find: "@/libs/state/app-state-context",
                  replacement: join(
                    root,
                    "test/browser/task-context.ts",
                  ),
                },
              ]
            : []),
          { find: "@", replacement: join(root, "src") },
        ],
      },
      optimizeDeps: { entries: [entry] },
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        open: false,
      },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    const query =
      cacheBenchmark && process.argv.includes("--repeating")
        ? "?repeating=1"
        : "";
    const url = `http://127.0.0.1:${address.port}/${entry}${query}`;
    const probe = await fetch(url);
    if (!probe.ok)
      throw new Error(`Test page HTTP ${probe.status}`);
    browser = spawn(
      process.env.CHROMIUM_PATH ?? "chromium",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
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
      browserLog = (browserLog + data).slice(-8000);
    });
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (browserError) throw browserError;
      try {
        port = Number(
          (
            await readFile(
              join(profile, "DevToolsActivePort"),
              "utf8",
            )
          ).split("\n")[0],
        );
        break;
      } catch {
        await sleep(100);
      }
    }
    if (!port)
      throw new Error(
        `Chromium did not start. ${browserLog}`,
      );
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    const page = targets.find(
      (target) => target.type === "page",
    );
    if (!page)
      throw new Error(
        "Chromium did not expose a test page",
      );
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    if (taskUi)
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: Number(process.env.TASK_TEST_WIDTH ?? 1000),
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
    await cdp.call("Page.navigate", { url });
    const start = Date.now();
    while (Date.now() - start < 80000) {
      const evaluation = await cdp.call(
        "Runtime.evaluate",
        {
          expression:
            "({report:window.__SPEED_TEST_REPORT__,error:window.__SPEED_TEST_ERROR__})",
          returnByValue: true,
        },
      );
      if (evaluation.exceptionDetails)
        throw new Error(
          JSON.stringify(evaluation.exceptionDetails),
        );
      const value = evaluation.result.value;
      if (value?.error) throw new Error(value.error);
      if (value?.report) {
        if (!value.report.ok)
          throw new Error("Browser smoke test failed");
        const json = JSON.stringify(value.report, null, 2);
        if (process.env.SPEED_TEST_REPORT)
          await writeFile(
            process.env.SPEED_TEST_REPORT,
            json + "\n",
          );
        if (taskUi && process.env.TASK_TEST_SCREENSHOT) {
          const shot = await cdp.call(
            "Page.captureScreenshot",
            { format: "png" },
          );
          await writeFile(
            process.env.TASK_TEST_SCREENSHOT,
            Buffer.from(shot.data, "base64"),
          );
        }
        if (
          taskUi &&
          process.env.TASK_TEST_SCREENSHOT_INFO
        ) {
          await cdp.call("Runtime.evaluate", {
            expression:
              "window.__TASK_TEST_OPEN_SESSION__()",
            awaitPromise: true,
          });
          const shot = await cdp.call(
            "Page.captureScreenshot",
            { format: "png" },
          );
          await writeFile(
            process.env.TASK_TEST_SCREENSHOT_INFO,
            Buffer.from(shot.data, "base64"),
          );
        }
        console.log(json);
        return;
      }
      await sleep(200);
    }
    throw new Error(
      `Browser smoke test timed out. ${browserLog}`,
    );
  } catch (error) {
    if (browserLog) console.error(browserLog);
    throw error;
  } finally {
    cdp?.close();
    if (
      browser?.pid &&
      browser.exitCode === null &&
      browser.signalCode === null
    ) {
      await new Promise((resolve) => {
        const timer = setTimeout(
          () => browser.kill("SIGKILL"),
          2000,
        );
        browser.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        browser.kill("SIGTERM");
      });
    }
    await vite?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
