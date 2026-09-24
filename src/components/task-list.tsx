import { userErrorMessage } from "@/libs/user-error";
import {
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import {
  ArrowUpRight,
  FileScan,
  Gauge,
  ListTodo,
  Search,
  X,
} from "lucide-solid";
import {
  FileTransferDetails,
  FileTransferIndicator,
} from "@/components/conversations/file-transfer-indicator";
import { toast } from "solid-sonner";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Separator } from "@/components/ui/seprartor";
import {
  IconAddCircle,
  IconCheck,
} from "@/components/icons";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import {
  type AppTask,
  type TaskListItem,
  type FileTask,
  type SharedFileTask,
  isFinishedTask,
  isActiveTask,
  type TaskStatus,
} from "@/libs/application/task-service";
import { formatBtyeSize } from "@/libs/utils/format-filesize";

type InspectTask = (peerId: string, speed: boolean) => void;
type TaskKind = AppTask["kind"];

const taskStatuses: TaskStatus[] = [
  "waiting",
  "running",
  "finalizing",
  "paused",
  "completed",
  "cancelled",
  "failed",
];

const taskKinds: TaskKind[] = [
  "file-prepare",
  "file-send",
  "file-receive",
  "speed-test",
];

function TaskFacetedFilter(props: {
  title: string;
  options: { label: string; value: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const toggle = (value: string) => {
    props.onChange(
      props.selected.includes(value)
        ? props.selected.filter((item) => item !== value)
        : [...props.selected, value],
    );
  };

  return (
    <Popover gutter={12}>
      <PopoverTrigger
        as={Button}
        variant="outline"
        size="sm"
        class="h-8 border-dashed"
      >
        <PopoverAnchor class="flex items-center">
          <IconAddCircle class="mr-1 size-4" />
          <span class="text-nowrap">{props.title}</span>
        </PopoverAnchor>
        <Show when={props.selected.length > 0}>
          <Separator
            orientation="vertical"
            class="mx-2 h-4"
          />
          <Badge
            variant="secondary"
            class="rounded-sm px-1 font-mono font-normal lg:hidden"
          >
            {props.selected.length}
          </Badge>
          <div class="hidden space-x-1 lg:flex">
            <Show
              when={props.selected.length <= 2}
              fallback={
                <Badge
                  variant="secondary"
                  class="rounded-sm px-1 font-normal"
                >
                  {props.selected.length}{" "}
                  {t("common.file_table.filter.selected")}
                </Badge>
              }
            >
              <For
                each={props.options.filter((option) =>
                  props.selected.includes(option.value),
                )}
              >
                {(option) => (
                  <Badge
                    variant="secondary"
                    class="rounded-sm px-1 font-normal"
                  >
                    {option.label}
                  </Badge>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </PopoverTrigger>
      <PopoverContent class="w-52 overflow-hidden p-0">
        <Command>
          <CommandInput placeholder={props.title} />
          <CommandList>
            <CommandEmpty>
              {t("tasks.filters.no_results")}
            </CommandEmpty>
            <CommandGroup>
              <For each={props.options}>
                {(option) => {
                  const selected = () =>
                    props.selected.includes(option.value);
                  return (
                    <CommandItem
                      onSelect={() => toggle(option.value)}
                    >
                      <div
                        class={cn(
                          `border-primary mr-2 flex size-4 items-center justify-center
                          rounded-sm border`,
                          selected()
                            ? "bg-primary text-primary-foreground"
                            : "opacity-50 [&_svg]:invisible",
                        )}
                      >
                        <IconCheck class="size-4" />
                      </div>
                      <span>{option.label}</span>
                    </CommandItem>
                  );
                }}
              </For>
            </CommandGroup>
            <Show when={props.selected.length > 0}>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  class="justify-center text-center"
                  onSelect={() => props.onChange([])}
                >
                  {t(
                    "common.file_table.filter.clear_filters",
                  )}
                </CommandItem>
              </CommandGroup>
            </Show>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TaskRow(props: {
  task: TaskListItem;
  onInspect: InspectTask;
}) {
  const app = useAppState();
  const [pending, setPending] = createSignal(false);
  const file = () =>
    ["file-send", "file-receive"].includes(props.task.kind)
      ? (props.task as FileTask | SharedFileTask)
      : undefined;
  const preparation = () =>
    props.task.kind === "file-prepare"
      ? props.task
      : undefined;
  const sharedFile = () => {
    const task = file();
    return task && "shared" in task ? task : undefined;
  };
  const speed = () =>
    props.task.kind === "speed-test"
      ? props.task.run
      : undefined;
  const currentSpeed = () =>
    app.speedTestState().id === speed()?.id;
  const awaitingLocalApproval = () =>
    currentSpeed() &&
    speed()?.status === "running" &&
    speed()?.incoming === true &&
    speed()?.progress?.phase === "approval";
  const peerName = () => taskPeerName(props.task);
  const online = () =>
    appState.session.clientViewData[props.task.peerId]
      ?.onlineStatus === "online";

  const resume = async () => {
    const task = file();
    if (task && "shared" in task) return task.resume();
    if (!task?.message?.fid || task.canResume === false)
      return;
    const message = task.message;
    const fid = message.fid!;
    if (message.room) {
      if (task.kind === "file-receive")
        await app.requestRoomFile(message);
    } else if (message.status === "error")
      await app.retryMessage(message);
    else if (task.kind === "file-send")
      await app.resumeFile(fid, task.peerId);
    else
      await app.requestFile(
        task.peerId,
        {
          id: fid,
          fileName: message.fileName,
          fileSize: message.fileSize,
          mimetype: message.mimeType,
          chunkSize: message.chunkSize,
          lastModified: message.lastModified,
          fingerprint: message.fingerprint,
          createdAt: message.createdAt,
        },
        true,
      );
  };

  const action = async (fn: () => void | Promise<void>) => {
    if (pending()) return;
    setPending(true);
    try {
      await fn();
    } catch {
      toast.error(t("tasks.action_failed"));
    } finally {
      setPending(false);
    }
  };

  const cancelSpeed = () => {
    if (app.speedTestState().id === speed()?.id)
      app.cancelSpeedTest(props.task.peerId);
  };

  const fileAction = () => {
    const task = file();
    if (task?.canPause) return "pause" as const;
    if (
      task?.canResume !== false &&
      task &&
      ["paused", "failed"].includes(task.status)
    )
      return "resume" as const;
    return undefined;
  };
  const label = () =>
    file()?.fileName ??
    preparation()?.fileName ??
    t("speed_test.title");
  const percent = (bytes: number, total: number) =>
    `${props.task.status === "completed" ? 100 : total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : 0}%`;

  return (
    <li
      data-task-id={props.task.id}
      class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start
        gap-x-3 gap-y-2 px-3 py-4 sm:px-4"
    >
      <Show
        when={file()}
        fallback={
          <div
            class="bg-muted text-muted-foreground flex size-11 items-center
              justify-center rounded-xl"
          >
            <Show
              when={preparation()}
              fallback={<Gauge class="size-5" />}
            >
              <FileScan class="size-5" />
            </Show>
          </div>
        }
      >
        {(task) => (
          <FileTransferIndicator
            received={
              task().status === "finalizing"
                ? undefined
                : task().bytes
            }
            total={task().total}
            complete={task().status === "completed"}
            busy={isActiveTask(task())}
            action={fileAction()}
            disabled={
              pending() ||
              (fileAction() === "resume" && !online())
            }
            onAction={() =>
              void action(
                fileAction() === "pause"
                  ? () => {
                      const task = file()!;
                      if ("shared" in task) task.pause();
                      else
                        return app.pauseFile(
                          task.message.fid!,
                          props.task.peerId,
                        );
                    }
                  : resume,
              )
            }
          />
        )}
      </Show>
      <div class="min-w-0 space-y-1.5">
        <div class="flex min-w-0 items-center gap-2">
          <p
            class="min-w-0 flex-1 truncate text-sm font-medium"
            title={label()}
          >
            {label()}
          </p>
          <Show when={!file()}>
            <span
              class={cn(
                "shrink-0 text-xs",
                props.task.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {t("tasks.status." + props.task.status)}
            </span>
          </Show>
        </div>
        <div
          class="text-muted-foreground flex min-w-0 items-center gap-1.5
            text-xs"
        >
          <span class="truncate" title={peerName()}>
            {peerName()}
          </span>
          <span aria-hidden="true">·</span>
          <span class="shrink-0">
            {t("tasks.kinds." + props.task.kind)}
          </span>
          <time
            class="ml-auto hidden shrink-0 tabular-nums sm:block"
            dateTime={new Date(
              props.task.statusChangedAt,
            ).toISOString()}
            title={new Date(
              props.task.statusChangedAt,
            ).toLocaleString()}
          >
            {new Date(
              props.task.statusChangedAt,
            ).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <Show when={file()}>
          {(task) => (
            <div class="text-muted-foreground flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <FileTransferDetails
                  status={t(
                    "tasks.status." + task().status,
                  )}
                  received={task().bytes}
                  total={task().total}
                  live={task().status === "running"}
                  error={task().error}
                />
              </div>
              <span class="w-9 shrink-0 text-right text-xs tabular-nums">
                {percent(task().bytes, task().total)}
              </span>
            </div>
          )}
        </Show>
        <Show when={preparation()}>
          {(task) => (
            <div class="space-y-1.5">
              <div
                class="text-muted-foreground flex justify-between gap-2 text-xs
                  tabular-nums"
              >
                <span>
                  {formatBtyeSize(task().bytes)} /{" "}
                  {formatBtyeSize(task().total)}
                </span>
                <span>
                  {percent(task().bytes, task().total)}
                </span>
              </div>
              <Progress
                aria-label={t("tasks.progress")}
                maxValue={task().total || 1}
                value={
                  task().status === "completed"
                    ? task().total || 1
                    : task().bytes
                }
              />
            </div>
          )}
        </Show>
        <Show when={speed()}>
          {(run) => (
            <>
              <Show
                when={
                  run().status === "running" &&
                  run().progress
                }
              >
                {(progress) => (
                  <p class="text-muted-foreground truncate text-xs tabular-nums">
                    {t(
                      progress().phase === "approval" &&
                        run().incoming
                        ? "speed_test.phases.approval_incoming"
                        : "speed_test.phases." +
                            progress().phase,
                    )}
                    <Show when={progress().bytes > 0}>
                      {" "}
                      · {formatBtyeSize(progress().bytes)}
                    </Show>
                  </p>
                )}
              </Show>
              <Show when={run().result}>
                {(result) => (
                  <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                    <span>
                      ↑{" "}
                      {(
                        (result().upload.bytesPerSecond *
                          8) /
                        1_000_000
                      ).toFixed(2)}{" "}
                      Mbps
                    </span>
                    <span>
                      ↓{" "}
                      {(
                        (result().download.bytesPerSecond *
                          8) /
                        1_000_000
                      ).toFixed(2)}{" "}
                      Mbps
                    </span>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show
          when={
            (file()?.error
              ? userErrorMessage(
                  file()!.error,
                  "errors.file_failed",
                )
              : undefined) ??
            (preparation()?.error
              ? userErrorMessage(
                  preparation()!.error,
                  "errors.file_failed",
                )
              : undefined) ??
            (speed()?.error
              ? t("speed_test.errors." + speed()!.error)
              : undefined)
          }
        >
          {(error) => (
            <p
              class="text-destructive truncate text-xs"
              title={error()}
            >
              {error()}
            </p>
          )}
        </Show>
      </div>
      <div class="flex items-center gap-1">
        <Show
          when={
            sharedFile() &&
            !["completed", "cancelled"].includes(
              props.task.status,
            )
          }
        >
          <Button
            size="icon"
            variant="ghost"
            class="size-8"
            aria-label={t("common.action.cancel")}
            title={t("common.action.cancel")}
            disabled={pending()}
            onClick={() =>
              void action(() => sharedFile()?.cancel())
            }
          >
            <X class="size-4" />
          </Button>
        </Show>
        <Show
          when={preparation() && isActiveTask(props.task)}
        >
          <Button
            size="icon"
            variant="ghost"
            class="size-8"
            aria-label={t("common.action.cancel")}
            title={t("common.action.cancel")}
            disabled={pending()}
            onClick={() =>
              void action(() => preparation()?.cancel())
            }
          >
            <X class="size-4" />
          </Button>
        </Show>
        <Show
          when={
            speed()?.status === "running" &&
            !awaitingLocalApproval()
          }
        >
          <Button
            size="icon"
            variant="ghost"
            class="size-8"
            aria-label={t("speed_test.cancel")}
            title={t("speed_test.cancel")}
            onClick={cancelSpeed}
          >
            <X class="size-4" />
          </Button>
        </Show>
        <Show when={!preparation()}>
          <Button
            size="icon"
            variant="ghost"
            class="size-8"
            aria-label={t("tasks.inspect")}
            title={t("tasks.inspect")}
            onClick={() =>
              props.onInspect(
                props.task.peerId,
                props.task.kind === "speed-test",
              )
            }
          >
            <ArrowUpRight class="size-4" />
          </Button>
        </Show>
      </div>
      <Show when={awaitingLocalApproval()}>
        <div class="col-span-2 col-start-2 flex justify-end gap-2">
          <Button
            size="sm"
            onClick={() =>
              app.approveSpeedTest(props.task.peerId)
            }
          >
            {t("speed_test.accept")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              app.declineSpeedTest(props.task.peerId)
            }
          >
            {t("speed_test.decline")}
          </Button>
        </div>
      </Show>
    </li>
  );
}

function taskPeerName(task: AppTask) {
  return task.kind === "file-prepare"
    ? t("tasks.local")
    : (appState.message.clients.find(
        (client) => client.clientId === task.peerId,
      )?.name ?? task.peerId);
}

export function TaskList(props: {
  onInspect: InspectTask;
}) {
  const app = useAppState();
  const [statusFilter, setStatusFilter] = createSignal<
    TaskStatus[]
  >([]);
  const [kindFilter, setKindFilter] = createSignal<
    TaskKind[]
  >([]);
  const [limit, setLimit] = createSignal(30);
  const [search, setSearch] = createSignal("");
  const query = () =>
    search().normalize("NFKC").trim().toLocaleLowerCase();
  const taskMap = createMemo(
    () =>
      new Map(
        app.tasks.tasks().map((task) => [task.id, task]),
      ),
  );

  const filtered = createMemo(() =>
    app.tasks.tasks().filter((task) => {
      if (
        statusFilter().length > 0 &&
        !statusFilter().includes(task.status)
      )
        return false;
      if (
        kindFilter().length > 0 &&
        !kindFilter().includes(task.kind)
      )
        return false;
      const name =
        task.kind === "speed-test"
          ? t("speed_test.title")
          : task.fileName;
      return (
        !query() ||
        [name, taskPeerName(task), task.peerId].some(
          (value) =>
            value
              .normalize("NFKC")
              .toLocaleLowerCase()
              .includes(query()),
        )
      );
    }),
  );

  const setStatuses = (values: string[]) => {
    setStatusFilter(values as TaskStatus[]);
    setLimit(30);
  };
  const setKinds = (values: string[]) => {
    setKindFilter(values as TaskKind[]);
    setLimit(30);
  };

  return (
    <section
      class="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
      aria-label={t("tasks.title")}
    >
      <div
        class="flex shrink-0 flex-wrap items-center gap-2"
        role="group"
        aria-label={t("tasks.filters_label")}
      >
        <div class="relative min-w-40 flex-1">
          <Search
            class="text-muted-foreground pointer-events-none absolute top-1/2
              left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            class="h-9 pl-9"
            value={search()}
            aria-label={t("tasks.search")}
            placeholder={t("tasks.search")}
            onInput={(event) => {
              setSearch(event.currentTarget.value);
              setLimit(30);
            }}
          />
        </div>
        <TaskFacetedFilter
          title={t("tasks.filters.status")}
          selected={statusFilter()}
          onChange={setStatuses}
          options={taskStatuses.map((status) => ({
            value: status,
            label: t("tasks.status." + status),
          }))}
        />
        <TaskFacetedFilter
          title={t("tasks.filters.type")}
          selected={kindFilter()}
          onChange={setKinds}
          options={taskKinds.map((kind) => ({
            value: kind,
            label: t("tasks.kinds." + kind),
          }))}
        />
        <Show
          when={
            search() ||
            statusFilter().length ||
            kindFilter().length
          }
        >
          <Button
            size="icon"
            variant="ghost"
            class="size-8"
            aria-label={t(
              "common.file_table.filter.clear_filters",
            )}
            title={t(
              "common.file_table.filter.clear_filters",
            )}
            onClick={() => {
              setSearch("");
              setStatuses([]);
              setKinds([]);
            }}
          >
            <X class="size-4" />
          </Button>
        </Show>
      </div>
      <div
        class="scrollbar-thin min-h-0 flex-1 overflow-y-auto
          overscroll-contain rounded-xl border"
      >
        <Show
          when={filtered().length}
          fallback={
            <div
              class="text-muted-foreground flex flex-col items-center gap-3 px-4
                py-16 text-center text-sm"
            >
              <ListTodo class="size-9 opacity-50" />
              <p>{t("tasks.empty")}</p>
            </div>
          }
        >
          <ul
            class="divide-y"
            aria-label={t("tasks.title")}
          >
            <For
              each={filtered()
                .slice(0, limit())
                .map((task) => task.id)}
            >
              {(id) => (
                <Show when={taskMap().get(id)}>
                  {(task) => (
                    <TaskRow
                      task={task()}
                      onInspect={props.onInspect}
                    />
                  )}
                </Show>
              )}
            </For>
          </ul>
          <Show when={filtered().length > limit()}>
            <div class="flex justify-center border-t p-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setLimit((value) => value + 30)
                }
              >
                {t("tasks.show_more")}
              </Button>
            </div>
          </Show>
        </Show>
      </div>
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <p class="text-muted-foreground text-xs tabular-nums">
          {t("tasks.count", {
            active: app.tasks.activeCount(),
            total: app.tasks.tasks().length,
          })}
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={!app.tasks.tasks().some(isFinishedTask)}
          onClick={app.tasks.clearFinished}
        >
          {t("tasks.clear_finished")}
        </Button>
      </div>
      <p class="text-muted-foreground shrink-0 text-xs">
        {t("tasks.retention_note")}
      </p>
    </section>
  );
}
