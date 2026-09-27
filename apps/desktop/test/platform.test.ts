import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { platform } from "../src/platform";
import { isExternalLink } from "@weblink/platform";

describe("desktop platform boundary", () => {
  const ipc = vi.fn();
  let dispose = () => {};

  beforeEach(() => {
    ipc.mockReset();
    mockIPC(ipc);
    dispose = platform.initialize();
  });

  afterEach(() => {
    dispose();
    clearMocks();
    document.body.replaceChildren();
  });

  const click = (href: string, download = false) => {
    const link = document.createElement("a");
    link.href = href;
    if (download) link.download = "received.txt";
    document.body.append(link);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    let intercepted = false;
    window.addEventListener(
      "click",
      (event) => {
        intercepted = event.defaultPrevented;
        // Observe the adapter before suppressing jsdom's unimplemented navigation.
        event.preventDefault();
      },
      { once: true },
    );
    link.dispatchEvent(event);
    return intercepted;
  };

  it("queries the native runtime and never advertises a web update channel", async () => {
    const capabilities = {
      runtime: "desktop",
      os: "windows",
      version: "0.1.0",
      nativeScreenCapture: false,
      remoteInput: false,
    };
    ipc.mockResolvedValue(capabilities);
    expect(await platform.getCapabilities()).toEqual(
      capabilities,
    );
    expect(ipc).toHaveBeenCalledWith(
      "runtime_capabilities",
      {},
    );
    expect(platform.supportsServiceWorker).toBe(false);
  });

  it("opens external web links through the system browser", () => {
    expect(click("https://webl.ink/help")).toBe(true);
    expect(ipc).toHaveBeenCalledWith(
      "plugin:opener|open_url",
      {
        url: "https://webl.ink/help",
        with: undefined,
      },
    );
  });

  it("keeps router navigation and file downloads inside the webview", () => {
    expect(click("/about")).toBe(false);
    expect(click("blob:http://localhost/file", true)).toBe(
      false,
    );
    expect(ipc).not.toHaveBeenCalled();
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ms-settings:privacy",
    "https://user:password@example.com",
  ])("blocks unsafe external URL %s", (url) => {
    expect(isExternalLink(new URL(url))).toBe(false);
    expect(click(url)).toBe(true);
    expect(ipc).not.toHaveBeenCalled();
  });

  it("releases handlers when the application owner is disposed", () => {
    dispose();
    click("https://webl.ink");
    expect(ipc).not.toHaveBeenCalled();
  });

  it("rejects malformed external links before the webview navigates", () => {
    expect(click("http://[")).toBe(true);
    expect(ipc).not.toHaveBeenCalled();
  });
});
