import {
  createEffect,
  createMemo,
  createSignal,
  type Accessor,
} from "solid-js";
import type { FileMetaData } from "@/libs/domain/file";
import type {
  FileTransferMessage,
  StoreMessage,
} from "../domain/message";
import {
  findMessageTransfer,
  type FileTransferStates,
} from "./transfer/file-transfer-state";
import type { SpeedTestState } from "./speed-test-service";

export type TaskStatus =
  | "waiting"
  | "running"
  | "finalizing"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

interface TaskBase {
  id: string;
  peerId: string;
  createdAt: number;
  status: TaskStatus;
}

export interface FileTask extends TaskBase {
  kind: "file-send" | "file-receive";
  message: FileTransferMessage;
  fileName: string;
  canPause: boolean;
  bytes: number;
  total: number;
  error?: string;
}

export type SpeedTestRun = SpeedTestState & {
  id: string;
  peerId: string;
  startedAt: number;
};

export interface SpeedTask extends TaskBase {
  kind: "speed-test";
  run: SpeedTestRun;
}

export type AppTask = FileTask | SpeedTask;

export const isActiveTask = (task: AppTask): boolean =>
  ["waiting", "running", "finalizing"].includes(
    task.status,
  );

export const isFinishedTask = (task: AppTask): boolean =>
  ["completed", "cancelled", "failed"].includes(
    task.status,
  );

export interface TaskSources {
  clientId: Accessor<string>;
  messages: Accessor<readonly StoreMessage[]>;
  caches: Accessor<
    Record<string, FileMetaData | undefined>
  >;
  transfers: Accessor<FileTransferStates>;
}

/** Adapt existing file state rather than maintaining a second transfer state machine. */
export function fileTasks(
  sources: TaskSources,
): FileTask[] {
  const self = sources.clientId();
  const messages = sources
    .messages()
    .filter(
      (message): message is FileTransferMessage =>
        message.type === "file" &&
        !!message.fid &&
        (message.client === self ||
          message.target === self),
    );
  const caches = sources.caches();
  const transfers = sources.transfers();
  return messages.map((message) => {
    const outgoing = message.client === self;
    const cache = caches[message.fid!];
    const live = !!findMessageTransfer(transfers, message);
    let status: TaskStatus;
    if (!outgoing && cache?.isMerging)
      status = "finalizing";
    else if (
      message.transferStatus === "complete" ||
      (!outgoing && cache?.isComplete)
    )
      status = "completed";
    else if (live)
      status = message.progress ? "running" : "waiting";
    else if (
      message.transferStatus === "error" ||
      message.status === "error"
    )
      status = "failed";
    else if (message.status === "sending")
      status = "waiting";
    else status = "paused";

    const total = Math.max(0, message.fileSize);
    return {
      id: `file:${message.id}`,
      kind: outgoing ? "file-send" : "file-receive",
      peerId: outgoing ? message.target : message.client,
      createdAt: message.createdAt,
      status,
      message,
      fileName:
        cache?.file?.name ||
        cache?.fileName ||
        message.fileName ||
        message.fid!,
      canPause:
        live &&
        status !== "finalizing" &&
        status !== "completed",
      total,
      bytes:
        status === "completed"
          ? total
          : Math.min(
              total,
              Math.max(0, message.progress?.received ?? 0),
            ),
      error:
        status === "failed" ? message.error : undefined,
    };
  });
}

function speedTask(run: SpeedTestRun): SpeedTask {
  const status: TaskStatus =
    run.status === "done"
      ? "completed"
      : run.status === "error"
        ? "failed"
        : run.status === "cancelled"
          ? "cancelled"
          : run.progress?.phase === "approval" ||
              run.progress?.phase === "connecting"
            ? "waiting"
            : "running";
  return {
    id: `speed:${run.id}`,
    peerId: run.peerId,
    createdAt: run.startedAt,
    status,
    kind: "speed-test",
    run,
  };
}

/** Owned by AppStateProvider, never by a modal or a route. No connections here. */
export function createTaskService(sources: TaskSources) {
  const [speedRuns, setSpeedRuns] = createSignal<
    SpeedTestRun[]
  >([]);
  const [hiddenFiles, setHiddenFiles] = createSignal<
    Set<string>
  >(new Set());
  const files = createMemo(() => fileTasks(sources));
  createEffect(() => {
    const resumed = files()
      .filter((task) => !isFinishedTask(task))
      .map((task) => task.id);
    setHiddenFiles((previous) => {
      if (!resumed.some((id) => previous.has(id)))
        return previous;
      const next = new Set(previous);
      resumed.forEach((id) => next.delete(id));
      return next;
    });
  });
  const tasks = createMemo<AppTask[]>(() =>
    [
      ...files().filter(
        (task) =>
          !hiddenFiles().has(task.id) ||
          !isFinishedTask(task),
      ),
      ...speedRuns().map(speedTask),
    ].sort(
      (a, b) =>
        Number(isActiveTask(b)) - Number(isActiveTask(a)) ||
        b.createdAt - a.createdAt,
    ),
  );
  const activeCount = createMemo(
    () => tasks().filter(isActiveTask).length,
  );

  const recordSpeedTest = (state: SpeedTestState) => {
    if (
      !state.id ||
      !state.peerId ||
      state.startedAt === undefined
    )
      return;
    const run = state as SpeedTestRun;
    setSpeedRuns((previous) =>
      [
        run,
        ...previous.filter((item) => item.id !== run.id),
      ]
        .sort((a, b) => b.startedAt - a.startedAt)
        .filter(
          (item, index) =>
            index < 50 || item.status === "running",
        ),
    );
  };
  const latestSpeedTest = (peerId: string | null) =>
    speedRuns().find((run) => run.peerId === peerId);
  const clearFinished = () => {
    setHiddenFiles(
      (previous) =>
        new Set([
          ...previous,
          ...files()
            .filter(isFinishedTask)
            .map((task) => task.id),
        ]),
    );
    setSpeedRuns((previous) =>
      previous.filter((run) => run.status === "running"),
    );
  };

  return {
    tasks,
    activeCount,
    recordSpeedTest,
    latestSpeedTest,
    clearFinished,
  };
}

export type TaskService = ReturnType<
  typeof createTaskService
>;
