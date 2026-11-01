import { expect, it, vi } from "vitest";
import template from "../src-tauri/src/receive/release.js?raw";

const source = template
  .replace(
    "__INVOKE_KEY__",
    JSON.stringify("test-invoke-key"),
  )
  .replace(
    "__ORIGINS__",
    JSON.stringify(["https://tauri.localhost"]),
  );
const install = new Function("window", "location", source);

it("posts a one-way string envelope without exposing its key or registering callbacks", () => {
  const postMessage = vi.fn();
  const page: any = {
    chrome: { webview: { postMessage } },
  };
  page.top = page;
  install(page, { origin: "https://tauri.localhost" });
  const releases = [{ slot: 0, lease: 3 }];
  expect(
    page.__WEBLINK_RECEIVE_RELEASE__("receiver", releases),
  ).toBeUndefined();
  expect(postMessage).toHaveBeenCalledOnce();
  expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({
    cmd: "receive_release",
    callback: 0,
    error: 0,
    payload: { id: "receiver", releases },
    __TAURI_INVOKE_KEY__: "test-invoke-key",
  });
  expect(
    page.__WEBLINK_RECEIVE_RELEASE__.toString(),
  ).not.toContain("test-invoke-key");
  expect(
    Object.getOwnPropertyDescriptor(
      page,
      "__WEBLINK_RECEIVE_RELEASE__",
    )?.writable,
  ).toBe(false);
});

it("does not install a native bridge in foreign documents or subframes", () => {
  for (const [origin, subframe] of [
    ["https://example.test", false],
    ["https://tauri.localhost", true],
  ] as const) {
    const page: any = {};
    page.top = subframe ? {} : page;
    install(page, { origin });
    expect(
      page.__WEBLINK_RECEIVE_RELEASE__,
    ).toBeUndefined();
  }
});
