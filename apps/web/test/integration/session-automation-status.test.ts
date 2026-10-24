// @vitest-environment jsdom
import {
  createEffect,
  createRoot,
  createSignal,
} from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { SessionService } from "@/libs/application/session-service";
import type {
  PeerSession,
  PeerSessionEventMap,
} from "@/libs/domain/session";
import type { SessionMessage } from "@/libs/domain/protocol/messages";
import { validCapabilityUpdate } from "@/libs/domain/protocol/capabilities";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import { flushRtc } from "../support/rtc-transport";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

it("publishes actual input ownership only to its trusted peer on the current connection", async () => {
  const service = new SessionService();
  const [allowed, setAllowed] = createSignal(true);
  vi.spyOn(service, "canReceive").mockImplementation(
    allowed,
  );
  const bind = (id: string) => {
    const events =
      new MultiEventEmitter<PeerSessionEventMap>();
    const send = vi.fn(
      async (_message: SessionMessage) => {},
    );
    const session = {
      clientId: "host",
      targetClientId: id,
      isMessageChannelReady: true,
      sendMessage: send,
      addEventListener:
        events.addEventListener.bind(events),
    } as unknown as PeerSession;
    const stop = service.capabilities.bind(
      session,
      () => {},
    );
    createRoot((dispose) => {
      disposers.push(dispose, stop);
      createEffect(() =>
        service.capabilities.refresh(session),
      );
    });
    const automation = () => {
      const message = send.mock.lastCall?.[0];
      if (
        message?.type !== "peer-capabilities" ||
        !validCapabilityUpdate(message.update) ||
        message.update.kind === "request-snapshot"
      )
        throw new Error("Expected a capability update");
      return message.update.services["automation/1"];
    };
    return { session, events, send, automation };
  };
  const controller = bind("controller");
  const observer = bind("observer");
  await flushRtc();
  expect(controller.automation()).toBeUndefined();
  service.setDiagnosticsReady(true);
  await flushRtc();
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: false,
  });
  expect(observer.automation()).toEqual({
    diagnostics: true,
    controlActive: false,
  });
  service.setAutomationEnabled(true);
  observer.send.mockClear();
  const generation = service.capabilities.generation(
    controller.session,
  )!;
  service.setAutomationController({
    id: "controller",
    generation,
  });
  await flushRtc();
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: true,
  });
  expect(observer.send).not.toHaveBeenCalled();

  service.setAutomationController(null);
  await flushRtc();
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: false,
  });
  service.setAutomationController({
    id: "controller",
    generation,
  });
  await flushRtc();
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: true,
  });
  setAllowed(false);
  await flushRtc();
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: false,
  });
  setAllowed(true);
  await flushRtc();
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: true,
  });

  controller.events.dispatchEvent(
    "messagechannelchange",
    "closed",
  );
  controller.events.dispatchEvent(
    "messagechannelchange",
    "ready",
  );
  await flushRtc();
  expect(
    service.capabilities.generation(controller.session),
  ).not.toBe(generation);
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: false,
  });
  service.setAutomationEnabled(false);
  await flushRtc();
  expect(controller.automation()).toEqual({
    diagnostics: true,
    controlActive: false,
  });
  service.setDiagnosticsReady(false);
  await flushRtc();
  expect(controller.automation()).toBeNull();
});
