import {
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

export interface SessionDiagnostics {
  reports: unknown[];
  candidateRoute?: string;
  rttMs?: number;
  outgoingBitrate?: number;
  bytesSent?: number;
  bytesReceived?: number;
  error?: boolean;
}

const finiteNumber = (
  value: unknown,
): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0
    ? value
    : undefined;

export function parseSessionDiagnostics(
  stats: RTCStatsReport,
): SessionDiagnostics {
  const reports: Record<string, unknown>[] = [];
  stats.forEach((report) => reports.push(report));
  const sctp = reports.find(
    (report) => report.type === "sctp-transport",
  );
  const transport =
    (sctp?.transportId
      ? stats.get(String(sctp.transportId))
      : undefined) ??
    reports.find(
      (report) =>
        report.type === "transport" &&
        report.selectedCandidatePairId,
    );
  const pair = transport?.selectedCandidatePairId
    ? stats.get(String(transport.selectedCandidatePairId))
    : undefined;
  const result: SessionDiagnostics = { reports };
  if (!pair) return result;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  result.candidateRoute =
    [local?.candidateType, remote?.candidateType]
      .filter(Boolean)
      .join(" → ") || undefined;
  const rtt = finiteNumber(pair.currentRoundTripTime);
  result.rttMs = rtt === undefined ? undefined : rtt * 1000;
  result.outgoingBitrate = finiteNumber(
    pair.availableOutgoingBitrate,
  );
  result.bytesSent = finiteNumber(pair.bytesSent);
  result.bytesReceived = finiteNumber(pair.bytesReceived);
  return result;
}

/** Polling belongs to the visible view; the running speed test does not. */
export function createSessionDiagnostics(
  connection: Accessor<
    RTCPeerConnection | null | undefined
  >,
  enabled: Accessor<boolean>,
): Accessor<SessionDiagnostics> {
  const [state, setState] =
    createSignal<SessionDiagnostics>({ reports: [] });
  createEffect(() => {
    const pc = connection();
    const active = enabled();
    setState({ reports: [] });
    if (!pc || !active) return;
    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const stats = await pc.getStats();
        if (!retired)
          setState(parseSessionDiagnostics(stats));
      } catch {
        if (!retired)
          setState({ reports: [], error: true });
      } finally {
        if (!retired)
          timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    onCleanup(() => {
      retired = true;
      clearTimeout(timer);
    });
  });
  return state;
}
