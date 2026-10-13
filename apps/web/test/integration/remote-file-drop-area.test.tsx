// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteFileDropArea } from "@/routes/home/components/remote-file-drop-area";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import type { RemoteFileDrop } from "@/libs/application/remote-file-drop";
import { toast } from "solid-sonner";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@/libs/utils/process-file", () => ({
  handleDropItems: vi.fn(async () => []),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup() {
  const control = {
    fileDropTarget: () => ({ grantId: "grant" }),
  } as RemotePointer;
  const service = {
    hover: vi.fn<RemoteFileDrop["hover"]>(),
    leave: vi.fn(),
    drop: vi.fn<RemoteFileDrop["drop"]>(async () => {}),
  };
  const view = render(() => (
    <RemoteFileDropArea
      active
      enabled
      clientId="peer"
      control={control}
      service={service}
      point={(event) =>
        event.clientX < 0 ? undefined : { x: 0.2, y: 0.3 }
      }
    >
      <span>Remote screen</span>
    </RemoteFileDropArea>
  ));
  const root = view.container.firstElementChild!;
  const child = root.firstElementChild!;
  const read = vi.fn();
  const data = {
    types: ["Files"],
    items: [
      { kind: "file", type: "image/png", getAsFile: read },
    ],
    files: [],
    dropEffect: "none",
  };
  const drag = (
    type: string,
    target: Element = child,
    x = 10,
    relatedTarget: EventTarget | null = null,
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      relatedTarget,
    });
    Object.defineProperty(event, "dataTransfer", {
      value: data,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { ...view, root, child, service, drag, read };
}
it("forwards file hover positions without reading protected file bytes", () => {
  const s = setup();
  s.drag("dragenter");
  s.drag("dragover");
  expect(s.service.hover).toHaveBeenLastCalledWith(
    "peer",
    expect.anything(),
    { x: 0.2, y: 0.3 },
    ["image/png"],
    expect.any(Function),
  );
  expect(s.read).not.toHaveBeenCalled();
  expect(s.service.drop).not.toHaveBeenCalled();
  s.drag("dragleave", s.child, 10, s.root);
  expect(s.service.leave).not.toHaveBeenCalled();
  s.drag("dragleave", s.root, 10, document.body);
  expect(s.service.leave).toHaveBeenCalledOnce();
});
it("shows a native hover failure once during a drag before any drop", async () => {
  const s = setup();
  s.service.hover.mockRejectedValue(
    new Error("Could not initialize OLE"),
  );
  s.drag("dragenter");
  await Promise.resolve();
  s.drag("dragover");
  await Promise.resolve();
  expect(toast.error).toHaveBeenCalledOnce();
  expect(toast.error).toHaveBeenCalledWith(
    "remote_control.file_drop.failed",
    {
      description: "Could not initialize OLE",
    },
  );
  expect(s.service.drop).not.toHaveBeenCalled();
});
it("reports an asynchronous host failure after a position notification was already sent", async () => {
  const s = setup();
  s.service.hover.mockResolvedValue(undefined);
  s.drag("dragenter");
  await Promise.resolve();
  const report = s.service.hover.mock.calls[0][4]!;
  report(new Error("Native hover stopped"));
  expect(toast.error).toHaveBeenCalledWith(
    "remote_control.file_drop.failed",
    {
      description: "Native hover stopped",
    },
  );
});
it("hands a real drop to the transfer without treating the subsequent dragend as cancellation", async () => {
  const s = setup();
  s.drag("dragover");
  s.drag("drop");
  s.drag("dragend");
  expect(s.service.drop).toHaveBeenCalledOnce();
  expect(s.service.leave).not.toHaveBeenCalled();
});
it.each(["blur", "unmount", "margin"])(
  "cancels the remote hover on %s",
  (action) => {
    const s = setup();
    s.drag("dragover");
    if (action === "unmount") s.unmount();
    else if (action === "margin")
      s.drag("dragover", s.child, -1);
    else window.dispatchEvent(new Event("blur"));
    expect(s.service.leave).toHaveBeenCalledOnce();
    expect(s.service.drop).not.toHaveBeenCalled();
  },
);
