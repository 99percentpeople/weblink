import { RemoteFileDrop } from "@/libs/application/remote-file-drop";
import { RemoteClipboard } from "@/libs/application/remote-clipboard";
import { FileCacheFactory } from "@/libs/application/cache-service";
import { toNativeClipboard } from "@/libs/application/clipboard-content";
import { TransferRegistry } from "@/libs/application/transfer/transfer-registry";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import { FILE_TRANSFER_CHANNEL_PROTOCOL } from "@/libs/domain/transfer/protocol";
import { FileSender } from "@/libs/domain/transfer/file-sender";
import { FileReceiver } from "@/libs/domain/transfer/file-receiver";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { PeerSession } from "@/libs/domain/session";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import type { PlatformRuntime } from "@weblink/platform";
import { FakeRtcTransport } from "../../support/rtc-transport";

const report = window as typeof window & {
  __SPEED_TEST_REPORT__?: unknown;
  __SPEED_TEST_ERROR__?: string;
};
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Connection timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
async function main() {
  const bytes = new Uint8Array(12 * 1024 * 1024 + 13);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const entries = await toNativeClipboard([
    {
      type: "file",
      name: "copied.bin",
      blob: new Blob([bytes]),
    },
  ]);
  const factory = new FileCacheFactory();
  await factory.initialize();
  let imported = 0;
  let dropped = 0;
  const dropTarget = {
    sourceId: "screen",
    mediaId: "media",
    geometryRevision: "geometry",
  };
  let epoch = "epoch";
  let focusChanged = false;
  const control = Object.assign(new EventTarget(), {
    state: () => "active",
    fileDropTarget: () => ({
      grantId: "grant",
      target: dropTarget,
    }),
    clipboardGrant: () => "grant",
    clipboardEpoch: () => epoch,
    input: () => true,
  }) as unknown as RemotePointer;
  const peers = [0, 1].map((index) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const transport = new FakeRtcTransport();
    const protocol = new P2PProtocol(transport);
    const session = {
      clientId: `peer${index}`,
      targetClientId: `peer${1 - index}`,
      isMessageChannelReady: true,
      peerConnection: pc,
      createChannel: async (
        label: string,
        wireProtocol: string,
      ) =>
        pc.createDataChannel(label, {
          protocol: wireProtocol,
          ordered: true,
        }),
    } as PeerSession;
    const registry = new TransferRegistry({
      createTransfer: ({ cache, mode, info }) => {
        if (mode === TransferMode.Send)
          return new FileSender({
            cache,
            info,
            blockSize: 32 * 1024,
            compressionLevel: 0,
            maxMessageSize: pc.sctp?.maxMessageSize,
          });
        const receiver = new FileReceiver({ cache, info });
        receiver.addEventListener(
          "progress",
          ({ detail }) => {
            if (
              focusChanged ||
              detail.received < 8 * 1024 * 1024
            )
              return;
            focusChanged = true;
            // Opening the task list resets remote input focus but retains the control grant.
            queueMicrotask(() => {
              epoch = `${epoch}-refocused`;
              control.dispatchEvent(new Event("change"));
            });
          },
        );
        return receiver;
      },
      publish: () => {},
      bind: () => {},
      complete: async () => {},
      failed: () => {},
      automaticCacheDeletion: () => false,
      reportError: console.error,
    });
    pc.ondatachannel = ({ channel }) => {
      if (
        channel.protocol === FILE_TRANSFER_CHANNEL_PROTOCOL
      )
        registry.acceptChannel(
          session,
          channel.label.slice(0, -2),
          channel,
        );
    };
    const caches = {
      temporaryTransferCache: async (id: string) => {
        const raw = await factory.temporaryTransferCache(
          index === 0 ? id : `${id}-host`,
        );
        if (index === 0) return raw;
        // Isolate the host's physical database in this shared test origin.
        return new Proxy(raw, {
          get(target, key) {
            if (key === "id") return id;
            if (key === "getInfo")
              return async () => {
                const info = await target.getInfo();
                return info && { ...info, id };
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        });
      },
    };
    const service = new RemoteClipboard({
      platform: (index === 1
        ? {
            clipboard: {
              sequence: async () => 1,
              read: async () => ({ sequence: 2, entries }),
            },
          }
        : {}) as PlatformRuntime,
      host: {
        clipboardScope: () => ({
          ownerId: "owner",
          clientId: "peer0",
          grantId: "grant",
        }),
      },
      protocol,
      rtc: transport,
      registry,
      caches,
      enabled: () => true,
      fileDestination: () => "cache",
      cacheFile: async (file, signal) => {
        const result = await factory.library.importFile(
          file,
          { signal, silent: true },
        );
        const stored = await result.cache.getFile();
        const restored =
          stored &&
          new Uint8Array(await stored.arrayBuffer());
        if (
          !restored ||
          restored.length !== bytes.length ||
          !restored.every((byte, i) => byte === bytes[i])
        )
          throw new Error("Imported file bytes changed");
        imported++;
      },
      getSession: (id) =>
        id === session.targetClientId ? session : undefined,
    });
    const fileDrop = new RemoteFileDrop({
      platform: (index === 1
        ? {
            fileDrop: {
              prepare: async (
                _scope,
                _id,
                target,
                point,
              ) => {
                if (
                  JSON.stringify(target) !==
                    JSON.stringify(dropTarget) ||
                  point.x !== 0.25 ||
                  point.y !== 0.75
                )
                  throw new Error("Drop target changed");
              },
              apply: async (_scope, _id, files) => {
                if (
                  files.length !== 1 ||
                  files[0].name !== "dropped.bin"
                )
                  throw new Error("Drop filenames changed");
                const decoded = atob(files[0].data);
                if (decoded.length !== bytes.length)
                  throw new Error("Drop size changed");
                for (let i = 0; i < bytes.length; i++)
                  if (decoded.charCodeAt(i) !== bytes[i])
                    throw new Error(
                      "Dropped file bytes changed",
                    );
                dropped++;
              },
              cancel: async () => {},
            },
          }
        : {}) as PlatformRuntime,
      host: {
        clipboardScope: () => ({
          ownerId: "owner",
          clientId: "peer0",
          grantId: "grant",
        }),
      },
      protocol,
      rtc: transport,
      registry,
      caches,
      enabled: () => index === 0,
      getSession: (id) =>
        id === session.targetClientId ? session : undefined,
    });
    return {
      pc,
      service,
      fileDrop,
      transport,
      protocol,
      registry,
      session,
    };
  });
  peers.forEach((peer, i) => {
    peer.transport.sendImpl = (_session, message) => {
      void peers[1 - i].transport.emit(
        peers[1 - i].session,
        message,
      );
    };
  });
  const [a, b] = peers;
  a.pc.createDataChannel("bootstrap");
  try {
    await a.pc.setLocalDescription(
      await a.pc.createOffer(),
    );
    await until(
      () => a.pc.iceGatheringState === "complete",
    );
    await b.pc.setRemoteDescription(a.pc.localDescription!);
    await b.pc.setLocalDescription(
      await b.pc.createAnswer(),
    );
    await until(
      () => b.pc.iceGatheringState === "complete",
    );
    await a.pc.setRemoteDescription(b.pc.localDescription!);
    await until(
      () =>
        a.pc.connectionState === "connected" &&
        b.pc.connectionState === "connected",
    );
    await a.service.copy("peer1", control);
    if (
      imported !== 1 ||
      peers.some(
        (peer) =>
          peer.service.tasks()[0]?.status !== "completed",
      )
    )
      throw new Error(
        "Copy did not complete on both peers",
      );
    focusChanged = false;
    await a.fileDrop.drop(
      "peer1",
      control,
      { x: 0.25, y: 0.75 },
      async () => [new File([bytes], "dropped.bin")],
    );
    if (
      dropped !== 1 ||
      !focusChanged ||
      peers.some(
        (peer) =>
          peer.fileDrop.tasks()[0]?.status !== "completed",
      )
    )
      throw new Error(
        "Drop did not complete on both peers",
      );
    report.__SPEED_TEST_REPORT__ = {
      ok: true,
      imported,
      dropped,
      bytes: bytes.length,
      nativeChannels: true,
      workersAndIndexedDB: true,
      focusChanged,
    };
  } catch (error) {
    throw new Error(
      `${String(error)}; tasks=${JSON.stringify(peers.map((peer) => peer.service.tasks().map(({ status, error }) => ({ status, error }))))}`,
    );
  } finally {
    peers.forEach((peer) => {
      peer.service.dispose();
      peer.fileDrop.dispose();
      peer.protocol.dispose();
      peer.registry.clear();
      peer.pc.close();
    });
    factory.library.dispose();
  }
}
void main().catch((error) => {
  report.__SPEED_TEST_ERROR__ = String(error);
});
