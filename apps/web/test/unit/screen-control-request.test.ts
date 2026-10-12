import { expect, it, vi } from "vitest";
import { ScreenControlRequest } from "@/libs/domain/native-screen/control-request";

it("blocks an avatar request while occupied and waits for the host to confirm release", () => {
  const send = vi.fn();
  const control = new ScreenControlRequest(send);
  control.setAvailable(true);
  control.setHostStatus(undefined, "viewer");
  control.request();
  expect(send).not.toHaveBeenCalled();
  control.setHostStatus(
    {
      state: "controlled",
      clientId: "other",
      sourceId: "screen",
    },
    "viewer",
  );
  expect(control.state()).toBe("busy");
  control.request();
  expect(send).not.toHaveBeenCalled();
  control.setHostStatus(
    { state: "pending", clientId: "other", sourceId: null },
    "viewer",
  );
  control.request();
  expect(send).not.toHaveBeenCalled();
  control.setHostStatus({ state: "idle" }, "viewer");
  expect(control.state()).toBe("viewing");
  control.request();
  expect(send).toHaveBeenCalledOnce();
  control.cancel();
});
