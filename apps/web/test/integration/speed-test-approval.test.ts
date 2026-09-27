// @vitest-environment jsdom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createSpeedTestApproval } from "@/components/speed-test-approval";

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

describe("speed-test approval", () => {
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

  it("declines from the toast, closes it and opens the speed-test panel", async () => {
    const controller = createSpeedTestApproval();
    const abort = new AbortController();

    const pending = controller.request(
      "peer",
      "Peer",
      abort.signal,
    );

    const options = mocks.info.mock.calls[0][1];
    options.cancel.onClick();

    expect(mocks.openDetails).toHaveBeenCalledWith(
      "peer",
      "speed",
    );
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
