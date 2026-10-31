// A one-way Tauri message: no callback is registered and the native handler
// deliberately does not resolve it. Wry requires string WebView2 messages.
(() => {
  const key = __INVOKE_KEY__;
  const origins = __ORIGINS__;
  if (
    window.top !== window ||
    !origins.includes(location.origin)
  )
    return;
  Object.defineProperty(
    window,
    "__WEBLINK_RECEIVE_RELEASE__",
    {
      value: (id, releases) =>
        window.chrome.webview.postMessage(
          JSON.stringify({
            cmd: "receive_release",
            callback: 0,
            error: 0,
            payload: { id, releases },
            __TAURI_INVOKE_KEY__: key,
          }),
        ),
    },
  );
})();
