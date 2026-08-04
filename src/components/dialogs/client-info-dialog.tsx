import { ConnectionBadge } from "@/components/common/connection-badge";
import { createDialog } from "@/components/dialogs/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { PeerSession } from "@/libs/core/session";
import {
  ClientInfo,
  Client,
  ClientID,
} from "@/libs/core/type";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { appState } from "@/libs/state/app-state";

const clientInfoDialog = () => {
  const [target, setTarget] = createSignal<ClientID | null>(
    null,
  );

  const info = createMemo<ClientInfo | null>(() => {
    return target()
      ? (appState.session.clientViewData[target()!] ?? null)
      : null;
  });
  const client = createMemo<Client | null>(() => {
    return target()
      ? (appState.message.clients.find(
          (client) => client.clientId === target(),
        ) ?? null)
      : null;
  });

  const session = createMemo<PeerSession | null>(() => {
    return target()
      ? appState.session.sessions[target()!]
      : null;
  });

  const [stats, setStats] = createSignal<{
    reports: any[];
    candidateType: string | undefined;
  }>({
    reports: [],
    candidateType: undefined,
  });

  const updateStats = async (pc: RTCPeerConnection) => {
    const stats = await pc.getStats();
    const reports: any[] = [];
    let candidateType: string | undefined;
    stats.forEach((report) => {
      reports.push(report);
      if (report.type === "transport") {
        let activeCandidatePair = stats.get(
          report.selectedCandidatePairId,
        ) as RTCIceCandidatePairStats;
        if (!activeCandidatePair) return;
        let remoteCandidate = stats.get(
          activeCandidatePair.remoteCandidateId,
        );
        let localCandidate = stats.get(
          activeCandidatePair.localCandidateId,
        );
        if (
          localCandidate?.candidateType ||
          remoteCandidate?.candidateType
        ) {
          candidateType =
            localCandidate?.candidateType ??
            remoteCandidate?.candidateType;
        }
      }
    });
    setStats({ reports, candidateType });
  };

  let timer: number | undefined;
  onMount(() => {
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      const pc = session()?.peerConnection;
      if (pc) {
        updateStats(pc);
      }
    }, 1000);
    onCleanup(() => {
      window.clearInterval(timer);
      timer = undefined;
    });
  });

  createEffect(() => {
    const pc = session()?.peerConnection;
    if (pc) {
      updateStats(pc);
    }
  });

  const { open: openDialog } = createDialog({
    title: () =>
      t("common.client_info_dialog.title", {
        name: client()?.name,
      }),
    content: () => (
      <div class="grid grid-cols-3 gap-2 p-1 text-nowrap">
        <div class="col-span-3 flex items-center justify-between gap-2">
          <Label>
            {t("common.client_info_dialog.client_id")}
          </Label>
          <Input
            readOnly
            value={client()?.clientId}
            class="overflow-x-auto"
          />
        </div>
        <div class="col-span-3 flex items-center justify-between gap-2">
          <Label>
            {t("common.client_info_dialog.status")}
          </Label>
          <ConnectionBadge client={info() ?? undefined} />
        </div>
        <Show when={info()}>
          {(info) => (
            <>
              <div class="col-span-3 flex items-center justify-between gap-2">
                <Label>
                  {t(
                    "common.client_info_dialog.created_at",
                  )}
                </Label>
                <p class="text-sm">
                  {new Date(
                    info()?.createdAt ?? 0,
                  ).toLocaleString()}
                </p>
              </div>
              <div class="col-span-3 flex items-center justify-between gap-2">
                <Label>
                  {t(
                    "common.client_info_dialog.candidate_type",
                  )}
                </Label>
                <p>
                  <Badge variant="outline">
                    {stats().candidateType}
                  </Badge>
                </p>
              </div>
              <div class="col-span-3 flex flex-col gap-1">
                <Label>
                  {t(
                    "common.client_info_dialog.stats_reports",
                  )}
                </Label>
                <Textarea
                  readOnly
                  value={JSON.stringify(
                    stats().reports,
                    null,
                    2,
                  )}
                  class="scrollbar-thin h-64 w-full overflow-auto font-mono text-xs
                    text-nowrap"
                />
              </div>
            </>
          )}
        </Show>
      </div>
    ),
  });

  const open = (clientId: ClientID) => {
    setTarget(clientId);
    openDialog();
  };

  return {
    open,
  };
};

export default clientInfoDialog;
