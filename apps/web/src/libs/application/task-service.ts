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
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { RoomFileTransferState } from "../domain/message";
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
  canResume?: boolean;
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

import type { FilePreparation } from "./file-fingerprint-service";
export interface SharedFileTask extends Omit<
  FileTask,
  "message"
> {
  message?: never;
  shared: true;
  fileId: string;
  pause(): void;
  resume(): Promise<void>;
  cancel(): Promise<void>;
}
export type AppTask =
  | SharedFileTask
  | FileTask
  | SpeedTask
  | FilePreparation;

export type TaskListItem = AppTask & {
  statusChangedAt: number;
};

export const isActiveTask = (task: AppTask): boolean =>
  ["waiting", "running", "finalizing"].includes(
    task.status,
  );

export const isFinishedTask = (task: AppTask): boolean =>
  ["completed", "cancelled", "failed"].includes(
    task.status,
  );

export interface TaskSources {
  preparations?: Accessor<FilePreparation[]>;
  sharedFiles?: Accessor<SharedFileTask[]>;
  clearSharedFiles?(): void;
  clearPreparations?(): void;
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
  const task = (
    message: FileTransferMessage,
    peerId: string,
    outgoing: boolean,
    state: RoomFileTransferState,
    live: boolean,
    id = `file:${message.id}`,
  ): FileTask => {
    const candidate = caches[message.fid!];
    const cache =
      !message.room ||
      (candidate?.roomAttachment &&
        candidate.roomOfferId === message.id &&
        candidate.from === message.client &&
        candidate.fileName === message.fileName &&
        candidate.fileSize === message.fileSize &&
        candidate.chunkSize === message.chunkSize &&
        candidate.lastModified === message.lastModified &&
        (candidate.mimetype ?? "") ===
          (message.mimeType ?? ""))
        ? candidate
        : undefined;
    let status: TaskStatus;
    if (!outgoing && cache?.isMerging)
      status = "finalizing";
    else if (
      state.status === "complete" ||
      (!outgoing &&
        !message.localContentDetached &&
        cache?.isComplete)
    )
      status = "completed";
    else if (message.localContentPending)
      status = "waiting";
    else if (live)
      status = state.progress ? "running" : "waiting";
    else if (
      state.status === "error" ||
      (!message.room && message.status === "error")
    )
      status = "failed";
    else if (state.status === "paused") status = "paused";
    else if (!message.room && message.status === "sending")
      status = "waiting";
    else status = "paused";
    const total = Math.max(0, message.fileSize);
    return {
      id,
      kind: outgoing ? "file-send" : "file-receive",
      peerId,
      createdAt: message.createdAt,
      status,
      message,
      fileName:
        cache?.file?.name ||
        cache?.fileName ||
        message.fileName ||
        message.fid!,
      canPause:
        (live || !!message.localContentPending) &&
        status !== "finalizing" &&
        status !== "completed",
      // Group uploads resume only when that recipient asks for its missing chunks.
      canResume: !message.room || !outgoing,
      total,
      bytes:
        status === "completed"
          ? total
          : Math.min(
              total,
              Math.max(
                0,
                state.progress?.received ?? 0,
                !outgoing &&
                  !(
                    message.localContentDetached &&
                    findMessageTransfer(transfers, message)
                  )
                  ? (cache?.cachedBytes ?? 0)
                  : 0,
              ),
            ),
      error: status === "failed" ? state.error : undefined,
    };
  };
  return messages.flatMap((message): FileTask[] => {
    const outgoing = message.client === self;
    if (message.room && outgoing) {
      const runs = Object.values(transfers).filter(
        (entry) =>
          entry?.messageId === message.id &&
          entry.fileId === message.fid &&
          entry.session.clientId === message.client &&
          entry.transferer.mode === TransferMode.Send,
      );
      const peers = new Set([
        ...Object.keys(message.roomTransfers ?? {}),
        ...runs.flatMap((entry) =>
          entry ? [entry.session.targetClientId] : [],
        ),
      ]);
      return [...peers].map((peerId) =>
        task(
          message,
          peerId,
          true,
          message.roomTransfers?.[peerId] ?? {},
          runs.some(
            (entry) =>
              entry?.session.targetClientId === peerId,
          ),
          `file:${JSON.stringify([message.id, peerId])}`,
        ),
      );
    }
    const live =
      !message.localContentDetached &&
      !!findMessageTransfer(transfers, message);
    if (message.room && !message.transferStatus && !live)
      return [];
    return [
      task(
        message,
        outgoing ? message.target : message.client,
        outgoing,
        {
          status: message.transferStatus,
          progress: message.progress,
          error: message.error,
        },
        live,
      ),
    ];
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
  const statusChanges = new Map<
    string,
    {
      status: TaskStatus;
      at: number;
      sequence: number;
    }
  >();
  let sequence = 0;
  let lastChangeAt = 0;
  // Once handed off, clearing/deleting a transfer must not resurrect its hash job.
  const absorbedPreparations = new Set<string>();
  const tasks = createMemo<TaskListItem[]>(() => {
    const shared = sources.sharedFiles?.() ?? [];
    const preparations = sources.preparations?.() ?? [];
    const preparationIds = new Set(
      preparations.map((task) => task.id),
    );
    for (const id of absorbedPreparations)
      if (!preparationIds.has(id))
        absorbedPreparations.delete(id);
    const self = sources.clientId();
    const ownedFiles = new Set([
      ...sources
        .messages()
        .flatMap((message) =>
          message.type === "file" &&
          message.fid &&
          (message.client === self ||
            message.target === self)
            ? [message.fid]
            : [],
        ),
      ...shared.map((task) => task.fileId),
    ]);
    const standalonePreparations = preparations.filter(
      (task) => {
        const owned = task.fileIds?.some((id) =>
          ownedFiles.has(id),
        );
        if (owned && task.status === "completed")
          absorbedPreparations.add(task.id);
        // Receive verification is already represented by the transfer's finalizing
        // state. Keep independent imports and unsuccessful identification attempts.
        return (
          !absorbedPreparations.has(task.id) &&
          !(owned && isActiveTask(task))
        );
      },
    );
    const current: AppTask[] = [
      ...files(),
      ...shared,
      ...speedRuns().map(speedTask),
      ...standalonePreparations,
    ];
    const ids = new Set(current.map((task) => task.id));
    for (const id of statusChanges.keys()) {
      if (!ids.has(id)) statusChanges.delete(id);
    }
    const items = current.map((task): TaskListItem => {
      let change = statusChanges.get(task.id);
      if (
        change
          ? change.status !== task.status
          : isActiveTask(task)
      ) {
        lastChangeAt = Math.max(lastChangeAt, Date.now());
        change = {
          status: task.status,
          at: lastChangeAt,
          sequence: ++sequence,
        };
      } else if (!change) {
        // Restored history has no observed transition in this app session.
        change = {
          status: task.status,
          at: task.createdAt,
          sequence: 0,
        };
      }
      statusChanges.set(task.id, change);
      return { ...task, statusChangedAt: change.at };
    });
    return items
      .filter(
        (task) =>
          !hiddenFiles().has(task.id) ||
          !isFinishedTask(task),
      )
      .sort(
        (a, b) =>
          b.statusChangedAt - a.statusChangedAt ||
          statusChanges.get(b.id)!.sequence -
            statusChanges.get(a.id)!.sequence ||
          b.createdAt - a.createdAt ||
          a.id.localeCompare(b.id),
      );
  });
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
    sources.clearPreparations?.();
    sources.clearSharedFiles?.();
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
