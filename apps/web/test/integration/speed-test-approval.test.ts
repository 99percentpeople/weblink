// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createSpeedTestApproval } from "@/components/speed-test-approval";
import { SPEED_TEST_APPROVAL_MS } from "@/libs/domain/speed-test-protocol";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  dismiss: vi.fn(),
  openDetails: vi.fn(),
}));

vi.mock("solid-sonner", () => ({
  toast: mocks,
}));

vi.mock("@/i18n", () => ({
  t: (key: string) => key,
}));

vi.mock(
  "@/components/dialogs/client-info-dialog-events",
  () => ({
    CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT:
      "weblink:client-info-dialog-tab-visible",
    requestClientInfoDialog: mocks.openDetails,
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.info.mockReturnValue("request-toast");
});
afterEach(() => vi.useRealTimers());

describe("speed-test approval", () => {
  it("exposes one exact approval and clears it when the panel responds", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();
    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );
    const request = controller.pending()!;
    expect(request).toMatchObject({
      peerId: "peer",
      name: "Peer",
    });
    expect(controller.accept("peer")).toBe(true);
    expect(controller.pending()).toBeUndefined();
    expect(request.respond(false)).toBe(false);
    await expect(pending).resolves.toBe(true);
  });

  it("rejects a notification action for a replaced request from the same peer", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();
    const first = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );
    const old = controller.pending()!;
    const second = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );
    expect(controller.pending()!.id).not.toBe(old.id);
    expect(old.respond(true)).toBe(false);
    await expect(first).resolves.toBe(false);
    expect(controller.pending()!.respond(false)).toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it.each(["abort", "timeout", "delayed-timer"])(
    "invalidates system actions after %s",
    async (reason) => {
      vi.useFakeTimers();
      const controller = createSpeedTestApproval();
      const abort = new AbortController();
      const pending = controller.request(
        "peer",
        "Peer",
        abort.signal,
      );
      const request = controller.pending()!;
      expect(request.expiresAt).toBe(
        Date.now() + SPEED_TEST_APPROVAL_MS,
      );
      if (reason === "abort") abort.abort();
      else if (reason === "timeout")
        vi.advanceTimersByTime(SPEED_TEST_APPROVAL_MS);
      else vi.setSystemTime(request.expiresAt);
      expect(request.respond(true)).toBe(false);
      expect(controller.pending()).toBeUndefined();
      await expect(pending).resolves.toBe(false);
    },
  );

  it("lets the in-app panel settle the same request shown by the toast", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();

    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );

    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0][1]).not.toHaveProperty(
      "description",
    );
    expect(mocks.info.mock.calls[0][1]).toHaveProperty(
      "action",
    );
    expect(mocks.info.mock.calls[0][1]).toHaveProperty(
      "cancel",
    );
    expect(controller.accept("other")).toBe(false);
    expect(controller.accept("peer")).toBe(true);
    await expect(pending).resolves.toBe(true);

    expect(mocks.dismiss).toHaveBeenCalledWith(
      "request-toast",
    );

    abort.abort();
  });

  it("opens the speed-test panel from the toast without settling the request", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();

    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );

    const toastElement = document.createElement("div");
    toastElement.className = "speed-test-request-toast";
    document.body.append(toastElement);
    toastElement.click();

    expect(mocks.openDetails).toHaveBeenCalledWith(
      "peer",
      "speed",
    );
    expect(mocks.dismiss).toHaveBeenCalledWith(
      "request-toast",
    );

    expect(controller.accept("peer")).toBe(true);
    await expect(pending).resolves.toBe(true);
    toastElement.remove();
  });

  it("dismisses the request toast when the matching speed-test panel becomes visible", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();

    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );

    window.dispatchEvent(
      new CustomEvent(
        "weblink:client-info-dialog-tab-visible",
        {
          detail: { clientId: "peer", tab: "speed" },
        },
      ),
    );

    expect(mocks.dismiss).toHaveBeenCalledWith(
      "request-toast",
    );

    // Hiding the toast must not accept or decline the request.
    expect(controller.accept("peer")).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it("accepts from the toast, closes it and opens the speed-test panel", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();

    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );

    const options = mocks.info.mock.calls[0][1];
    options.action.onClick();

    expect(mocks.openDetails).toHaveBeenCalledWith(
      "peer",
      "speed",
    );
    expect(mocks.dismiss).toHaveBeenCalledWith(
      "request-toast",
    );
    await expect(pending).resolves.toBe(true);
  });

  it("declines from the toast and closes it without opening the speed-test panel", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();

    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );

    const options = mocks.info.mock.calls[0][1];
    options.cancel.onClick();

    expect(mocks.openDetails).not.toHaveBeenCalled();
    expect(mocks.dismiss).toHaveBeenCalledWith(
      "request-toast",
    );
    await expect(pending).resolves.toBe(false);
  });

  it("declines without starting a running toast", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();

    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );

    expect(controller.decline("peer")).toBe(true);
    await expect(pending).resolves.toBe(false);
  });
});
