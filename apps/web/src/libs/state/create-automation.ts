import { appState, setAppState } from "./app-state";
import { readAutomationPolicy } from "@weblink/automation";
import { createUuid } from "@/libs/domain/ids";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import { combineAbortSignals } from "@/libs/utils/abort-signals";
import { PresentationDiagnostics } from "@/libs/application/automation/presentation";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  AutomationError,
  failure,
  parseCall,
  tools,
  type Approval,
  type Audit,
  type Grant,
  type Principal,
  type ToolCall,
  type ToolResult,
} from "@weblink/automation";
import {
  webMcpContext,
  registerWebMcp,
} from "@weblink/automation/webmcp";
import { platform } from "@/libs/platform/runtime";
import { DEFAULT_MCP_SERVER } from "@weblink/platform";
import type {
  NativeAutomationPeer,
  NativeAutomationRequest,
  McpTokenSummary,
  McpServerConfig,
} from "@weblink/platform";
import type { PeerSession } from "@/libs/domain/session";
import { sessionService } from "@/libs/application/session-service";
import { AutomationAudit } from "@/libs/application/automation/audit";
import { AutomationDiagnostics } from "@/libs/application/automation/diagnostics";
import {
  automationHandlers,
  diagnosticSources,
} from "@/libs/application/automation/handlers";
import {
  AutomationPeerLink,
  AUTOMATION_CHANNEL as CHANNEL,
} from "@/libs/application/automation/peer-link";
import type { AppStateContextProps } from "./app-state-context";
interface NativeSnapshot {
  enabled: boolean;
  mcpEnabled: boolean;
  endpoint: string;
  endpoints: string[];
  server: McpServerConfig;
  serverPending: boolean;
  policiesSuspended?: boolean;
  clients: McpTokenSummary[];
  grants: Grant[];
  pending: Approval[];
  audit: Audit[];
  jobs: {
    id: string;
    principal: string;
    status: string;
    exitCode: number | null;
    truncated: boolean;
  }[];
  controller?: Principal | null;
  activeCalls?: string[];
}
const empty: NativeSnapshot = {
  enabled: false,
  mcpEnabled: false,
  endpoint: "",
  endpoints: [],
  server: { ...DEFAULT_MCP_SERVER },
  serverPending: false,
  clients: [],
  grants: [],
  pending: [],
  audit: [],
  jobs: [],
  controller: null,
};
export type AutomationRuntime = ReturnType<
  typeof createAutomation
>;
export function createAutomation(
  state: AppStateContextProps,
) {
  const [enabled, setEnabled] = createSignal(false);
  const [mcpEnabled, setMcpEnabled] = createSignal(false);
  const active = () => enabled() || mcpEnabled();
  const [revision, setRevision] = createSignal(0);
  const [nativeState, updateNativeState] =
    createStore<NativeSnapshot>(structuredClone(empty));
  const setNativeState = (snapshot: NativeSnapshot) =>
    updateNativeState(reconcile(snapshot, { key: "id" }));
  const [error, setError] = createSignal("");
  const [ready, setReady] = createSignal(false);
  const changed = () => setRevision((v) => v + 1);
  const audit = new AutomationAudit(changed);
  const presentation = new PresentationDiagnostics();
  const diagnostics = new AutomationDiagnostics(() =>
    diagnosticSources(state, presentation, platform),
  );
  const handle = automationHandlers(
    state,
    platform,
    diagnostics,
  );
  const life = new AbortController();
  const webPrincipal: Principal = {
    id: "webmcp",
    label: "WebMCP · current page",
    kind: "webmcp",
  };
  const links = new Map<PeerSession, AutomationPeerLink>();
  const peerPrincipals = new Map<
    AutomationPeerLink,
    Promise<Principal & NativeAutomationPeer>
  >();
  const bindings = new Map<
    PeerSession,
    {
      abort: AbortController;
      opening?: object;
      pc: RTCPeerConnection | null;
      share: boolean;
      generation?: string;
    }
  >();
  const authorities = new Map<
    AutomationPeerLink,
    {
      principal: NativeAutomationPeer;
      session: PeerSession;
      policy: string;
      pending: Promise<void>;
    }
  >();
  const policyFor = (session: PeerSession) =>
    readAutomationPolicy(
      appState.options.clientConfigs[session.targetClientId]
        ?.automation,
    );
  const syncPolicy = (link: AutomationPeerLink) => {
    const authority = authorities.get(link);
    if (!authority || !native) return Promise.resolve();
    const policy = policyFor(authority.session);
    const key = JSON.stringify(policy);
    if (key !== authority.policy) {
      authority.policy = key;
      authority.pending = authority.pending.then(
        async () => {
          link.lifetime.signal.throwIfAborted();
          if (
            sessionService.sessions[
              authority.session.targetClientId
            ] !== authority.session ||
            sessionService.capabilities.generation(
              authority.session,
            ) !== authority.principal.generation ||
            !sessionService.canReceive(
              authority.session.targetClientId,
            )
          ) {
            throw new AutomationError(
              "TARGET_DISCONNECTED",
            );
          }
          await native.peerPolicy(
            epoch,
            authority.principal,
            policy,
          );
        },
      );
      void authority.pending.catch((e) => {
        if (
          !life.signal.aborted &&
          !link.lifetime.signal.aborted &&
          !(
            e instanceof AutomationError &&
            e.code === "TARGET_DISCONNECTED"
          )
        )
          setError(String(e));
        link.close();
      });
    }
    return authority.pending;
  };
  const calls = new Map<string, AbortController>();
  let epoch = "",
    timer: ReturnType<typeof setTimeout> | undefined,
    unregister: (() => void) | undefined;
  const native = platform.automation;
  const webSupported = () => !!webMcpContext(document);
  let webRegistration: AbortController | undefined;
  const configurationRevision = { automation: 0, mcp: 0 };
  let nativeConfiguration = Promise.resolve();
  let snapshotSequence = 0;
  const readNativeSnapshot = async () => {
    const sequence = ++snapshotSequence;
    const snapshot = (await native!.snapshot(
      epoch,
    )) as NativeSnapshot;
    if (
      sequence !== snapshotSequence ||
      life.signal.aborted
    )
      return;
    setNativeState(snapshot);
    return snapshot;
  };

  const principal = async (
    link: AutomationPeerLink,
    session: PeerSession,
    generation: string,
  ): Promise<Principal & NativeAutomationPeer> => {
    const peerId = session.targetClientId;
    await link.ready;
    link.lifetime.signal.throwIfAborted();
    if (
      sessionService.sessions[peerId] !== session ||
      sessionService.capabilities.generation(session) !==
        generation ||
      !sessionService.canReceive(peerId)
    )
      throw new AutomationError("TARGET_DISCONNECTED");
    let promise = peerPrincipals.get(link);
    if (!promise) {
      promise = (async () => {
        const p: Principal & NativeAutomationPeer = {
          id: peerId,
          label:
            sessionService.clientViewData[peerId]?.name ??
            peerId,
          kind: "peer" as const,
          generation,
        };
        if (native) {
          await native.peer(epoch, p, p.label);
          authorities.set(link, {
            principal: p,
            session,
            policy: "",
            pending: Promise.resolve(),
          });
          try {
            await syncPolicy(link);
          } catch (e) {
            authorities.delete(link);
            await native
              .disconnect(epoch, p)
              .catch(() => {});
            throw e;
          }
          changed();
        }
        return p;
      })();
      peerPrincipals.set(link, promise);
    }
    const p = await promise;
    // A setting can change while the preceding native write is in flight.
    // Wait for the latest policy before admitting another tool call.
    let pending: Promise<void>;
    do {
      pending = syncPolicy(link);
      await pending;
    } while (
      authorities.get(link)?.pending &&
      authorities.get(link)!.pending !== pending
    );
    if (
      link.lifetime.signal.aborted ||
      sessionService.sessions[peerId] !== session ||
      sessionService.capabilities.generation(session) !==
        generation ||
      !sessionService.canReceive(peerId)
    ) {
      throw new AutomationError("TARGET_DISCONNECTED");
    }
    return p;
  };
  const route = async (
    call: ToolCall,
    signal: AbortSignal,
    ticket?: string,
  ): Promise<Record<string, unknown>> => {
    const check = async () => {
      signal.throwIfAborted();
      if (native && ticket)
        await native.check(epoch, ticket);
      signal.throwIfAborted();
    };
    if (call.arguments.target !== "local") {
      await check();
      const session =
          sessionService.sessions[
            String(call.arguments.target)
          ],
        link = links.get(session);
      if (!link || !canConnect(session))
        throw new AutomationError("TARGET_DISCONNECTED");
      const result = await link.call(
        {
          ...call,
          arguments: { ...call.arguments, target: "local" },
        },
        signal,
      );
      if (!result.ok)
        throw new AutomationError(
          result.error.code,
          result.error.message,
        );
      return result.data;
    }
    await check();
    if (
      !native &&
      call.name !== "devices.list" &&
      call.name !== "commands.capabilities"
    )
      throw new AutomationError("UNSUPPORTED");
    return handle(
      call,
      signal,
      native && ticket
        ? (binding) => native.action(epoch, ticket, binding)
        : undefined,
      check,
    );
  };
  const invoke = async (
    p: Principal,
    call: ToolCall,
    signal: AbortSignal = life.signal,
  ): Promise<ToolResult> => {
    const operation = combineAbortSignals([
      signal,
      life.signal,
    ]);
    const cleanups = [operation.dispose];
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(new AutomationError("TIMEOUT")),
      270000,
    );
    try {
      if (!(p.kind === "webmcp" ? mcpEnabled() : enabled()))
        throw new AutomationError("DISABLED");
      if (p.kind === "webmcp")
        call = {
          ...call,
          source: { kind: "webmcp", label: p.label },
        };
      parseCall(call);
      const bounded = combineAbortSignals([
        operation.signal,
        deadline.signal,
      ]);
      cleanups.push(bounded.dispose);
      signal = bounded.signal;
      signal.throwIfAborted();
      if (native && p.kind === "peer") {
        if (!p.generation)
          throw new AutomationError("TARGET_DISCONNECTED");
        const id = createUuid();
        const cancel = () =>
          void native.cancel(epoch, id).catch(() => {});
        signal.addEventListener("abort", cancel, {
          once: true,
        });
        try {
          return (await native.call(
            epoch,
            { id: p.id, generation: p.generation },
            id,
            call,
          )) as ToolResult;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      }
      // WebMCP is a controller. Authority is enforced by the destination desktop.
      // A browser never accepts incoming peer automation calls.
      if (p.kind !== "webmcp" || native)
        throw new AutomationError("UNSUPPORTED");
      signal.throwIfAborted();
      const data = await route(call, signal);
      signal.throwIfAborted();
      audit.record(p, call, "ok");
      return { ok: true, data };
    } catch (e) {
      audit.record(
        p,
        call,
        e instanceof AutomationError ? e.code : "error",
      );
      return failure(e);
    } finally {
      clearTimeout(timeout);
      cleanups.forEach((dispose) => dispose());
    }
  };
  const receiveNative = async (
    request: NativeAutomationRequest,
  ) => {
    const controller = new AbortController();
    calls
      .get(request.id)
      ?.abort(new AutomationError("CANCELLED"));
    calls.set(request.id, controller);
    const combined = combineAbortSignals([
      controller.signal,
      life.signal,
    ]);
    const signal = combined.signal;
    const timeout = setTimeout(
      () =>
        controller.abort(new AutomationError("TIMEOUT")),
      150000,
    );
    let result: ToolResult;
    try {
      // Native tickets are authoritative, including cancellation during a toggle.
      parseCall(request.call);
      result = {
        ok: true,
        data: await route(request.call, signal, request.id),
      };
      signal.throwIfAborted();
    } catch (e) {
      result = failure(e);
    }
    clearTimeout(timeout);
    combined.dispose();
    // A cancelled invocation can finish after its ID has been reused.
    if (calls.get(request.id) !== controller) return;
    calls.delete(request.id);
    await native!
      .finish(epoch, request.id, result)
      .catch(() => {});
  };
  const canConnect = (session: PeerSession) => {
    const capabilities =
      sessionService.capabilities.get(session);
    // Both ends must accept application data. Otherwise the destination closes
    // every incoming channel and the polling loop keeps reopening it.
    return (
      sessionService.canReceive(session.targetClientId) &&
      !!capabilities?.automation &&
      capabilities.identity?.receiveContent === true
    );
  };
  let syncScheduled = false;
  const scheduleSync = () => {
    if (syncScheduled || life.signal.aborted) return;
    syncScheduled = true;
    queueMicrotask(() => {
      syncScheduled = false;
      if (!life.signal.aborted) untrack(sync);
    });
  };
  const bind = (
    session: PeerSession,
    channel: RTCDataChannel,
  ) => {
    const generation =
      sessionService.capabilities.generation(session);
    if (
      !generation ||
      channel.readyState === "closed" ||
      channel.readyState === "closing" ||
      !active() ||
      sessionService.sessions[session.targetClientId] !==
        session ||
      !session.isMessageChannelReady ||
      links.has(session) ||
      !canConnect(session)
    ) {
      channel.close();
      return;
    }
    const link: AutomationPeerLink = new AutomationPeerLink(
      channel,
      async (call, signal) => {
        if (!native || !enabled())
          return failure(
            new AutomationError(
              native ? "DISABLED" : "UNSUPPORTED",
            ),
          );
        if (
          !sessionService.canReceive(session.targetClientId)
        )
          return failure(
            new AutomationError("PERMISSION_DENIED"),
          );
        if (
          (call.name.startsWith("screen.") ||
            call.name.startsWith("control.")) &&
          !sessionService.canShareScreen(
            session.targetClientId,
          )
        )
          return failure(
            new AutomationError("PERMISSION_DENIED"),
          );
        return invoke(
          await principal(link, session, generation),
          call,
          signal,
        );
      },
      changed,
      () => {
        const promise = peerPrincipals.get(link);
        // Keep this session occupied until cleanup completes. Reopening the
        // automation channel within the same connection must not let late
        // cleanup unregister its replacement's identical device/generation.
        void Promise.resolve(promise)
          .then((p) => p && native?.disconnect(epoch, p))
          .catch(() => {})
          .finally(() => {
            peerPrincipals.delete(link);
            authorities.delete(link);
            if (links.get(session) === link)
              links.delete(session);
            changed();
            if (!link.failure) scheduleSync();
          });
      },
    );
    links.set(session, link);
    changed();
  };
  const sync = () => {
    const sessions = Object.values(sessionService.sessions);
    for (const [session, b] of bindings)
      if (!active() || !sessions.includes(session)) {
        b.abort.abort();
        bindings.delete(session);
        links.get(session)?.close();
      }
    if (!active()) return;
    for (const session of sessions) {
      let b = bindings.get(session);
      if (!b) {
        b = {
          abort: new AbortController(),
          pc: session.peerConnection,
          generation:
            sessionService.capabilities.generation(session),
          share: sessionService.canShareScreen(
            session.targetClientId,
          ),
        };
        bindings.set(session, b);
        session.addEventListener(
          "channel",
          ({ detail }) => {
            if (detail.label === CHANNEL) {
              if (detail.protocol === CHANNEL)
                bind(session, detail);
              else detail.close();
            }
          },
          { signal: b.abort.signal },
        );
        session.addEventListener(
          "messagechannelchange",
          ({ detail }) => {
            if (detail === "closed")
              links.get(session)?.close();
            else untrack(sync);
          },
          { signal: b.abort.signal },
        );
        session.addEventListener(
          "peerconnectioninit",
          () => untrack(sync),
          { signal: b.abort.signal },
        );
      }
      const currentLink = links.get(session);
      if (currentLink)
        void syncPolicy(currentLink).catch(() => {});
      const share = sessionService.canShareScreen(
        session.targetClientId,
      );
      if (b.share && !share) links.get(session)?.close();
      b.share = share;
      const generation =
        sessionService.capabilities.generation(session);
      if (
        b.pc !== session.peerConnection ||
        b.generation !== generation
      ) {
        links.get(session)?.close();
        b.pc = session.peerConnection;
        b.generation = generation;
        b.opening = undefined;
      }
      if (!canConnect(session)) {
        links.get(session)?.close();
        continue;
      }
      if (
        session.isMessageChannelReady &&
        session.clientId < session.targetClientId &&
        !links.has(session) &&
        !b.opening
      ) {
        const attempt = {};
        b.opening = attempt;
        const binding = b;
        const pc = session.peerConnection;
        void session
          .createChannel(CHANNEL, CHANNEL, (channel) => {
            if (
              binding.abort.signal.aborted ||
              binding.opening !== attempt ||
              session.peerConnection !== pc
            )
              channel.close();
            else bind(session, channel);
          })
          .catch(() => {})
          .finally(() => {
            if (binding.opening === attempt)
              binding.opening = undefined;
          });
      }
    }
  };
  // Refresh native status and cancellation checks. Native session lifetime and
  // input renewal do not depend on this renderer timer running in the background.
  const refreshNative = async () => {
    if (native && epoch)
      try {
        await native.heartbeat(epoch);
        const observed = new Map(calls);
        const snapshot = await readNativeSnapshot();
        for (const [id, c] of observed)
          if (
            snapshot?.activeCalls &&
            calls.get(id) === c &&
            !snapshot.activeCalls.includes(id)
          )
            c.abort(new AutomationError("CANCELLED"));
      } catch (e) {
        setError(String(e));
        setEnabled(false);
        setMcpEnabled(false);
        sessionService.setAutomationEnabled(false);
        for (const link of [...links.values()])
          link.close();
      }
    if (!life.signal.aborted)
      timer = setTimeout(() => void refreshNative(), 1000);
  };
  const configureFeature = async (
    feature: "automation" | "mcp",
    value: boolean,
  ) => {
    const mcp = feature === "mcp";
    const revision = ++configurationRevision[feature];
    const current = () =>
      !life.signal.aborted &&
      revision === configurationRevision[feature];
    setError("");
    try {
      if (!native && !mcp)
        throw new AutomationError("UNSUPPORTED");
      if (value && !globalThis.crypto?.subtle)
        throw new AutomationError(
          "SECURE_CONTEXT_REQUIRED",
          "Automation requires HTTPS or localhost",
        );
      const context =
        value && !native
          ? webMcpContext(document)
          : undefined;
      if (value && !native && !context)
        throw new AutomationError(
          "UNSUPPORTED",
          "WebMCP is unavailable in this browser",
        );
      if (native) {
        if (
          value &&
          platform.remoteControl?.configureShortcut &&
          (await platform.getCapabilities()).remoteInput
        ) {
          if (!current()) return;
          await platform.remoteControl.configureShortcut(
            resolveRemoteKeyboardOptions(
              appState.options.remoteKeyboard,
            ).emergencyShortcut,
          );
        }
        if (!current()) return;
        // Serialize native effects, while each switch supersedes only its own
        // older requests. Disabling either feature cannot re-enable the other.
        const pending = nativeConfiguration.then(
          async () => {
            if (current()) {
              if (mcp)
                await native.configureMcp(epoch, value);
              else await native.configure(epoch, value);
            }
          },
        );
        nativeConfiguration = pending.catch(() => {});
        await pending;
        if (!current()) return;
        await readNativeSnapshot();
      } else {
        webRegistration?.abort();
        unregister?.();
        unregister = undefined;
        setMcpEnabled(false);
        sessionService.setAutomationEnabled(false);
        if (value && context) {
          webRegistration = new AbortController();
          const close = await registerWebMcp(
            context,
            (call, signal) =>
              invoke(webPrincipal, call, signal),
            () => true,
            webRegistration.signal,
          );
          if (!current()) {
            close();
            return;
          }
          unregister = close;
        }
      }
      if (life.signal.aborted) {
        if (native && epoch)
          await native.close(epoch).catch(() => {});
        return;
      }
      if (!current()) return;
      if (mcp) setMcpEnabled(value);
      else setEnabled(value);
      sessionService.setAutomationEnabled(active());
      if (!active()) {
        for (const c of calls.values()) c.abort();
        for (const link of [...links.values()])
          link.close();
      }
      if (!enabled()) diagnostics.detail(0);
      untrack(sync);
      setAppState(
        "options",
        mcp ? "mcpEnabled" : "automationEnabled",
        value,
      );
      changed();
    } catch (e) {
      if (!current()) return;
      setError(String(e));
      throw e;
    }
  };
  const configure = (value: boolean) =>
    configureFeature("automation", value);
  const configureMcp = (value: boolean) =>
    configureFeature("mcp", value);
  createEffect(() => {
    const controller =
      ready() && enabled() ? nativeState.controller : null;
    sessionService.setAutomationController(
      controller?.kind === "peer" && controller.generation
        ? {
            id: controller.id,
            generation: controller.generation,
          }
        : null,
    );
  });
  createEffect(() => {
    Object.values(sessionService.sessions).forEach((s) => {
      sessionService.capabilities.get(s);
      sessionService.capabilities.generation(s);
      sessionService.canReceive(s.targetClientId);
      sessionService.canShareScreen(s.targetClientId);
      JSON.stringify(policyFor(s));
    });
    active();
    untrack(sync);
  });
  onMount(() => {
    diagnostics.start();
    void (async () => {
      if (native)
        try {
          epoch = await native.open((event) => {
            if (event.kind === "cancel") {
              calls
                .get(event.id)
                ?.abort(new AutomationError("CANCELLED"));
            } else {
              void receiveNative(event);
            }
          });
          if (life.signal.aborted) {
            await native.close(epoch);
            return;
          }
          setNativeState(
            (await native.snapshot(
              epoch,
            )) as NativeSnapshot,
          );
        } catch (e) {
          setError(String(e));
        }
      if (life.signal.aborted) return;
      if (
        native &&
        epoch &&
        appState.options.automationEnabled
      ) {
        try {
          await configure(true);
        } catch {
          /* Keep the saved preference for the next startup. */
        }
      }
      if (life.signal.aborted) return;
      if (
        (native ? epoch : webSupported()) &&
        appState.options.mcpEnabled
      ) {
        try {
          await configureMcp(true);
        } catch {
          /* Keep the independent MCP preference for the next startup. */
        }
      }
      if (life.signal.aborted) return;
      setReady(!native || !!epoch);
      if (native) void refreshNative();
    })();
  });
  onCleanup(() => {
    life.abort();
    clearTimeout(timer);
    webRegistration?.abort();
    unregister?.();
    diagnostics.dispose();
    presentation.clear();
    for (const b of bindings.values()) b.abort.abort();
    for (const l of [...links.values()]) l.close();
    sessionService.setAutomationEnabled(false);
    if (native && epoch)
      void native.close(epoch).catch(() => {});
  });
  return {
    presentation,
    enabled,
    mcpEnabled,
    active,
    configuredMcpEnabled: () => appState.options.mcpEnabled,
    configuredEnabled: () =>
      appState.options.automationEnabled,
    ready,
    error,
    configure,
    configureMcp,
    configureServer: async (config: McpServerConfig) => {
      if (!native) throw new AutomationError("UNSUPPORTED");
      await native.configureServer(epoch, config);
      const snapshot = await readNativeSnapshot();
      return snapshot?.server ?? config;
    },
    desktop: !!native,
    webSupported,
    controller: () =>
      native && ready() && enabled()
        ? (nativeState.controller ?? null)
        : null,
    controlledPeers: () => {
      revision();
      if (!ready() || !active()) return [];
      return [...links].flatMap(([session, link]) =>
        link.connected &&
        !link.lifetime.signal.aborted &&
        sessionService.sessions[session.targetClientId] ===
          session &&
        session.isMessageChannelReady &&
        bindings.get(session)?.generation ===
          sessionService.capabilities.generation(session) &&
        canConnect(session) &&
        sessionService.capabilities.get(session)?.automation
          ?.controlActive === true
          ? [
              {
                id: session.targetClientId,
                name:
                  sessionService.clientViewData[
                    session.targetClientId
                  ]?.name ?? session.targetClientId,
              },
            ]
          : [],
      );
    },
    releaseControl: async (clientId: string) => {
      const session = sessionService.sessions[clientId];
      const link = links.get(session);
      if (
        !active() ||
        !link?.connected ||
        link.lifetime.signal.aborted ||
        !session.isMessageChannelReady ||
        !canConnect(session) ||
        bindings.get(session)?.generation !==
          sessionService.capabilities.generation(session)
      )
        throw new AutomationError("TARGET_DISCONNECTED");
      const result = await link.call(
        {
          name: "control.release",
          arguments: { target: "local" },
        },
        life.signal,
      );
      if (!result.ok)
        throw new AutomationError(
          result.error.code,
          result.error.message,
        );
    },
    snapshot: () => {
      revision();
      return native
        ? nativeState
        : {
            ...empty,
            enabled: enabled(),
            mcpEnabled: mcpEnabled(),
            grants: [],
            pending: [],
            audit: audit.entries.slice(),
          };
    },
    peers: () => {
      revision();
      return [...links]
        .filter(
          ([, link]) =>
            link.connected && !link.lifetime.signal.aborted,
        )
        .map(([s]) => ({
          id: s.targetClientId,
          name:
            sessionService.clientViewData[s.targetClientId]
              ?.name ?? s.targetClientId,
        }));
    },
    decide: async (id: string, accepted: boolean) => {
      if (native) {
        await native.decide(epoch, id, accepted);
        await readNativeSnapshot();
      }
    },
    revoke: async (id?: string) => {
      if (native) {
        await native.revoke(epoch, id);
        await readNativeSnapshot();
      }
    },
    client: async (
      label: string,
      expiresAt: number | null,
    ) => {
      const result = await native!.client(
        epoch,
        label,
        expiresAt,
      );
      await readNativeSnapshot();
      return result;
    },
    updateClient: async (
      id: string,
      label: string,
      expiresAt: number | null,
    ) => {
      await native!.updateClient(
        epoch,
        id,
        label,
        expiresAt,
      );
      await readNativeSnapshot();
    },
    removeClient: async (id: string) => {
      await native!.removeClient(epoch, id);
      await readNativeSnapshot();
    },
    export: () => {
      const samples: unknown[] = [];
      let after = 0;
      while (true) {
        const page = diagnostics.read(after);
        samples.push(...(page.samples as unknown[]));
        if (!page.hasMore) break;
        after = Number(page.nextCursor);
      }
      return {
        format: "weblink-diagnostics/1",
        ...diagnostics.snapshot(),
        samples,
      };
    },
    toolCount: tools.length,
  };
}
