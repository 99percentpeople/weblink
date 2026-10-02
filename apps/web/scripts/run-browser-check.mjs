#!/usr/bin/env bun
// Run with Bun or Node 22+: built-in WebSocket, no automation dependency required.
import { createServer } from "vite";
import { connect } from "./browser-cdp.mjs";
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
const notificationsTest = process.argv.includes(
  "--notifications",
);
const taskUi = process.argv.includes("--tasks");
const chatUi = process.argv.includes("--chat");
const meetingUi = process.argv.includes("--meeting");
const playbackTest = process.argv.includes("--playback");
const dropTest = process.argv.includes("--drop");
const conversationStorage = process.argv.includes(
  "--conversations",
);
const ui =
  taskUi || chatUi || meetingUi || playbackTest || dropTest;
const protocolTest = process.argv.includes("--protocol");
const nativeScreenTest = process.argv.includes(
  "--native-screen",
);
const recoveryTest = process.argv.includes("--recovery");
const transferTest = process.argv.includes("--transfer");
const cacheBenchmark = process.argv.includes(
  "--cache-benchmark",
);
const cacheTest = process.argv.includes("--cache");
const entry = notificationsTest
  ? "test/e2e/smoke/notifications.html"
  : nativeScreenTest
    ? "test/e2e/smoke/native-screen.html"
    : dropTest
      ? "test/e2e/smoke/chat-file-drop.html"
      : playbackTest
        ? "test/e2e/smoke/video-playback.html"
        : recoveryTest
          ? "test/e2e/smoke/session-recovery.html"
          : meetingUi
            ? "test/e2e/smoke/meeting.html"
            : conversationStorage
              ? "test/e2e/smoke/conversation-storage.html"
              : chatUi
                ? "test/e2e/smoke/chat-scroll.html"
                : cacheBenchmark
                  ? "test/e2e/benchmark/cache-merge.html"
                  : cacheTest
                    ? "test/e2e/smoke/cache-merge.html"
                    : taskUi
                      ? "test/e2e/smoke/task-center.html"
                      : protocolTest
                        ? "test/e2e/smoke/rtc-protocol.html"
                        : transferTest
                          ? "test/e2e/smoke/transfer-workflow.html"
                          : "test/e2e/smoke/speed-test.html";
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const profile = await mkdtemp(
    join(tmpdir(), "weblink-browser-check-"),
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
      // Never overwrite a running dev server's optimized dependencies.
      cacheDir: join(profile, "vite-cache"),
      configFile: false,
      logLevel: "error",
      plugins:
        ui || nativeScreenTest
          ? [solidPlugin(), solidSvg(), tailwindcss()]
          : [],
      resolve: {
        conditions: ["browser", "development"],
        alias: [
          ...(taskUi || chatUi || meetingUi
            ? [
                {
                  find: "@/libs/state/app-state-context",
                  replacement: join(
                    root,
                    chatUi || meetingUi
                      ? "test/e2e/smoke/chat-context.ts"
                      : "test/e2e/smoke/task-context.ts",
                  ),
                },
              ]
            : []),
          { find: "@", replacement: join(root, "src") },
        ],
      },
      optimizeDeps: {
        entries: [entry],
        include: ["hash-wasm", "fflate"],
      },
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
      transferTest &&
      process.argv.includes("--legacy-abort")
        ? "?without-abort-any=1"
        : chatUi && process.env.CHAT_TEST_SCREENSHOT
          ? "?snapshot=1"
          : cacheBenchmark &&
              process.argv.includes("--repeating")
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
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        ...(nativeScreenTest
          ? [
              "--use-fake-device-for-media-stream",
              "--use-fake-ui-for-media-stream",
            ]
          : []),
        ...(protocolTest ||
        recoveryTest ||
        playbackTest ||
        nativeScreenTest
          ? ["--autoplay-policy=no-user-gesture-required"]
          : []),
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
    // Hosted runners can need more than ten seconds for a cold browser start.
    const startupDeadline = Date.now() + 30000;
    while (Date.now() < startupDeadline) {
      if (browserError) throw browserError;
      if (
        browser.exitCode !== null ||
        browser.signalCode !== null
      )
        throw new Error(
          `Chromium exited during startup (${browser.exitCode ?? browser.signalCode}). ${browserLog}`,
        );
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
    if (ui)
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: Number(
          process.env.MEETING_TEST_WIDTH ??
            process.env.CHAT_TEST_WIDTH ??
            process.env.TASK_TEST_WIDTH ??
            (meetingUi ? 1440 : 1000),
        ),
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
    if (chatUi || meetingUi) {
      await cdp.call("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-reduced-motion",
            value:
              process.env.CHAT_TEST_REDUCED_MOTION === "1"
                ? "reduce"
                : "no-preference",
          },
          {
            name: "prefers-color-scheme",
            value:
              process.env.CHAT_TEST_COLOR_SCHEME ?? "light",
          },
        ],
      });
    }
    if (notificationsTest)
      await cdp.call("Browser.grantPermissions", {
        origin: new URL(url).origin,
        permissions: ["notifications"],
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
          throw new Error("Browser check failed");
        const json = JSON.stringify(value.report, null, 2);
        if (process.env.SPEED_TEST_REPORT)
          await writeFile(
            process.env.SPEED_TEST_REPORT,
            json + "\n",
          );
        if (chatUi && process.env.CHAT_TEST_SCREENSHOT) {
          const shot = await cdp.call(
            "Page.captureScreenshot",
            { format: "png" },
          );
          await writeFile(
            process.env.CHAT_TEST_SCREENSHOT,
            Buffer.from(shot.data, "base64"),
          );
          await cdp.call("Runtime.evaluate", {
            expression:
              "window.__CHAT_TEST_FINISH_SNAPSHOT__()",
            awaitPromise: true,
          });
        }
        if (
          meetingUi &&
          process.env.MEETING_TEST_SCREENSHOT
        ) {
          const shot = await cdp.call(
            "Page.captureScreenshot",
            { format: "png" },
          );
          await writeFile(
            process.env.MEETING_TEST_SCREENSHOT,
            Buffer.from(shot.data, "base64"),
          );
        }
        if (
          meetingUi &&
          process.env.MEETING_TEST_ROOM_DIALOG_SCREENSHOT
        ) {
          const result = await cdp.call(
            "Runtime.evaluate",
            {
              expression:
                "window.__MEETING_OPEN_ROOM_SETTINGS__()",
              awaitPromise: true,
            },
          );
          if (result.exceptionDetails)
            throw new Error(
              JSON.stringify(result.exceptionDetails),
            );
          const shot = await cdp.call(
            "Page.captureScreenshot",
            { format: "png" },
          );
          await writeFile(
            process.env.MEETING_TEST_ROOM_DIALOG_SCREENSHOT,
            Buffer.from(shot.data, "base64"),
          );
        }
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
      `Browser check timed out. ${browserLog}`,
    );
  } catch (error) {
    // Report failure before async cleanup: Bun can exit while Vite is closing.
    process.exitCode = 1;
    console.error(error.stack ?? error);
    if (browserLog) console.error(browserLog);
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
    // Chromium children can still finish profile writes after the main process exits.
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
