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

  it("sends window preferences only through the local native configuration command", async () => {
    const options = {
      closeBehavior: "tray",
      hideOnRemoteControl: true,
      locale: "zh-cn",
    } as const;
    await platform.application!.configure(options);
    expect(ipc).toHaveBeenLastCalledWith(
      "application_configure",
      { options },
    );
  });

  it("keeps local authorization IPC separate from media input and binds the offer to its owner", async () => {
    const control = {
      ownerId: "owner",
      peerGeneration: "peer",
      clientId: "client",
      sourceId: "source",
    };
    ipc.mockResolvedValue("offer");
    await platform.screenShare!.offer(
      "capture",
      "media",
      [],
      false,
      false,
      undefined,
      control,
    );
    expect(ipc).toHaveBeenLastCalledWith(
      "capture_offer",
      expect.objectContaining({
        sessionId: "capture",
        peerId: "media",
        control,
      }),
    );
    await platform.remoteControl!.approve(
      "owner",
      "local-consent",
      true,
    );
    expect(ipc).toHaveBeenLastCalledWith(
      "remote_control_approve",
      {
        ownerId: "owner",
        consentId: "local-consent",
        approve: true,
      },
    );
    await platform.remoteControl!.status("owner");
    expect(ipc).toHaveBeenLastCalledWith(
      "remote_control_status",
      { ownerId: "owner" },
    );
    await platform.remoteControl!.end("owner");
    expect(ipc).toHaveBeenLastCalledWith(
      "remote_control_end",
      { ownerId: "owner" },
    );
  });

  it("reads physical display layout without starting or authorizing capture", async () => {
    const layout = {
      revision: "layout-1",
      virtualBounds: {
        left: -1920,
        top: 0,
        width: 3840,
        height: 1080,
      },
      displays: [],
    };
    ipc.mockResolvedValue(layout);
    expect(
      await platform.capture!.displayLayout!(),
    ).toEqual(layout);
    expect(ipc).toHaveBeenCalledOnce();
    expect(ipc).toHaveBeenCalledWith(
      "capture_display_layout",
      {},
    );
  });

  it("carries incremental ICE over the native control boundary", async () => {
    const candidate = {
      candidate: "candidate:host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const receive = vi.fn();
    await platform.screenShare!.offer(
      "capture",
      "peer",
      [],
      true,
      false,
      receive,
    );
    const [command, args] = ipc.mock.calls[0];
    expect(command).toBe("capture_offer");
    expect(args.relayOnly).toBe(true);
    args.candidates.onmessage(candidate);
    expect(receive).toHaveBeenCalledWith(candidate);
    await platform.screenShare!.addIceCandidate(
      "capture",
      "peer",
      candidate,
    );
    expect(ipc).toHaveBeenLastCalledWith(
      "capture_add_ice_candidate",
      {
        sessionId: "capture",
        peerId: "peer",
        candidate,
      },
    );
  });

  it("mutes the native audio sender through session-scoped IPC", async () => {
    await platform.screenShare!.setAudioEnabled!(
      "capture",
      false,
    );
    expect(ipc).toHaveBeenCalledWith(
      "capture_set_audio_enabled",
      { sessionId: "capture", enabled: false },
    );
  });

  it("reads video counters for only the selected native session and peer", async () => {
    ipc.mockResolvedValue([{ id: "video", bytes: 1000 }]);
    expect(
      await platform.screenShare!.stats!(
        "capture",
        "preview",
      ),
    ).toEqual([{ id: "video", bytes: 1000 }]);
    expect(ipc).toHaveBeenCalledWith(
      "capture_video_stats",
      { sessionId: "capture", peerId: "preview" },
    );
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
      displayRefreshRates: [60, 144],
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

  it("passes source identity and session ownership through the capture boundary", async () => {
    await platform.capture!.sources();
    await platform.capture!.start("selected-window");
    await platform.capture!.status("session-1");
    await platform.capture!.stop("session-1");
    expect(ipc.mock.calls).toEqual([
      ["capture_sources", {}],
      [
        "capture_start",
        { sourceId: "selected-window", options: {} },
      ],
      ["capture_status", { sessionId: "session-1" }],
      ["capture_stop", { sessionId: "session-1" }],
    ]);
  });

  it("loads a bounded binary thumbnail without starting a shared capture", async () => {
    ipc.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71]).buffer,
    );
    const image = await platform.capture!.thumbnail(
      "selected-window",
      { backend: "wgc" },
    );
    expect(image.type).toBe("image/png");
    expect(image.size).toBe(4);
    expect(ipc.mock.calls).toEqual([
      [
        "capture_thumbnail",
        {
          sourceId: "selected-window",
          options: { backend: "wgc" },
        },
      ],
    ]);
  });

  it("queries native codec capabilities and forwards explicit encoder settings", async () => {
    const options = {
      maxWidth: 1920,
      maxHeight: 1080,
      frameRate: 144,
      maxBitrate: 5_000_000,
      codec: "video/h264",
      audioSampleRate: 16000,
      audioChannelCount: 1 as const,
      audioCodec: "audio/opus",
      degradationPreference: "balanced" as const,
    };
    await platform.screenShare!.codecs();
    await platform.screenShare!.codecs("audio");
    await platform.screenShare!.audioFormats!();
    await platform.screenShare!.encoders();
    await platform.capture!.backends();
    await platform.screenShare!.start("source", options, {
      backend: "dxgi",
    });
    await platform.screenShare!.offer(
      "capture",
      "preview",
      [],
      false,
      true,
    );
    expect(ipc.mock.calls).toEqual([
      ["capture_codecs", { kind: "video" }],
      ["capture_codecs", { kind: "audio" }],
      ["capture_audio_formats", {}],
      ["capture_encoders", {}],
      ["capture_backends", {}],
      [
        "capture_share_start",
        {
          sourceId: "source",
          options,
          capture: { backend: "dxgi" },
        },
      ],
      [
        "capture_offer",
        {
          sessionId: "capture",
          peerId: "preview",
          iceServers: [],
          relayOnly: false,
          preview: true,
        },
      ],
    ]);
  });

  it("keeps media negotiation scoped to the capture session and forwards current TURN credentials", async () => {
    await platform.screenShare!.start("selected-window");
    await platform.screenShare!.offer(
      "capture",
      "receiver",
      [
        { urls: "stun:example.test" },
        {
          urls: ["turn:example.test"],
          username: "temporary-user",
          credential: "temporary-password",
        },
      ],
      true,
    );
    await platform.screenShare!.answer(
      "capture",
      "receiver",
      "answer-sdp",
    );
    await platform.screenShare!.closePeer(
      "capture",
      "receiver",
    );
    expect(ipc.mock.calls).toEqual([
      [
        "capture_share_start",
        {
          sourceId: "selected-window",
          options: {},
          capture: {},
        },
      ],
      [
        "capture_offer",
        {
          sessionId: "capture",
          peerId: "receiver",
          relayOnly: true,
          preview: false,
          iceServers: [
            {
              urls: ["stun:example.test"],
              username: "",
              credential: "",
            },
            {
              urls: ["turn:example.test"],
              username: "temporary-user",
              credential: "temporary-password",
            },
          ],
        },
      ],
      [
        "capture_answer",
        {
          sessionId: "capture",
          peerId: "receiver",
          sdp: "answer-sdp",
        },
      ],
      [
        "capture_close_peer",
        { sessionId: "capture", peerId: "receiver" },
      ],
    ]);
  });

  it("updates only video controls in the selected native session", async () => {
    const settings = {
      maxWidth: 1280,
      maxHeight: 720,
      frameRate: 60,
      maxBitrate: 2_000_000,
      degradationPreference: "balanced" as const,
    };
    await platform.screenShare!.updateVideoSettings(
      "owned",
      settings,
    );
    expect(ipc).toHaveBeenCalledWith(
      "capture_update_video_settings",
      { sessionId: "owned", settings },
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
