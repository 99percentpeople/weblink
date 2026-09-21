import {
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  type FileTask,
  isFinishedTask,
  type TaskStatus,
} from "@/libs/services/task-service";
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
  task: AppTask;
  onInspect: InspectTask;
}) {
  const app = useAppState();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const file = () =>
    props.task.kind !== "speed-test"
      ? (props.task as FileTask)
      : undefined;
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
  const peerName = () =>
    appState.message.clients.find(
      (client) => client.clientId === props.task.peerId,
    )?.name ?? props.task.peerId;
  const online = () =>
    appState.session.clientViewData[props.task.peerId]
      ?.onlineStatus === "online";

  const resume = async () => {
    const task = file();
    if (!task?.message.fid) return;
    const message = task.message;
    const fid = message.fid!;
    if (message.status === "error")
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
          createdAt: message.createdAt,
        },
        true,
      );
  };

  const action = async (fn: () => void | Promise<void>) => {
    setPending(true);
    setError(undefined);
    try {
      await fn();
    } catch {
      setError(t("tasks.action_failed"));
    } finally {
      setPending(false);
    }
  };

  const cancelSpeed = () => {
    if (app.speedTestState().id === speed()?.id)
      app.cancelSpeedTest(props.task.peerId);
  };

  return (
    <TableRow>
      <TableCell class="w-[18rem] max-w-[18rem] py-2">
        <p class="truncate text-sm font-medium">
          {file()?.fileName ?? t("speed_test.title")}
        </p>
        <p class="text-muted-foreground truncate text-xs">
          {t("tasks.kinds." + props.task.kind)} ·{" "}
          {peerName()}
        </p>
      </TableCell>

      <TableCell class="w-[7rem] py-2">
        <Badge variant="outline" class="whitespace-nowrap">
          {t("tasks.status." + props.task.status)}
        </Badge>
      </TableCell>

      <TableCell class="w-[16rem] max-w-[16rem] py-2 text-xs">
        <Show when={file()}>
          {(task) => (
            <div class="space-y-1">
              <Progress
                aria-label={t("tasks.progress")}
                maxValue={task().total || 1}
                value={
                  task().total === 0 &&
                  task().status === "completed"
                    ? 1
                    : task().bytes
                }
              />
              <p class="text-muted-foreground truncate tabular-nums">
                {formatBtyeSize(task().bytes)} /{" "}
                {formatBtyeSize(task().total)}
              </p>
              <Show when={task().error}>
                <p class="text-destructive truncate">
                  {task().error}
                </p>
              </Show>
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
                  <p class="truncate">
                    {t(
                      progress().phase === "approval" &&
                        run().incoming
                        ? "speed_test.phases.approval_incoming"
                        : "speed_test.phases." +
                            progress().phase,
                    )}
                    <Show when={progress().bytes > 0}>
                      {" · "}
                      {(
                        progress().bytes /
                        1024 /
                        1024
                      ).toFixed(2)}{" "}
                      MiB
                    </Show>
                  </p>
                )}
              </Show>
              <Show when={run().error}>
                {(code) => (
                  <p class="text-destructive truncate">
                    {t("speed_test.errors." + code())}
                  </p>
                )}
              </Show>
              <Show when={run().result}>
                {(result) => (
                  <div class="space-y-0.5 font-mono tabular-nums">
                    <p class="truncate">
                      ↑{" "}
                      {(
                        (result().upload.bytesPerSecond *
                          8) /
                        1_000_000
                      ).toFixed(2)}{" "}
                      Mbps
                    </p>
                    <p class="truncate">
                      ↓{" "}
                      {(
                        (result().download.bytesPerSecond *
                          8) /
                        1_000_000
                      ).toFixed(2)}{" "}
                      Mbps
                    </p>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>

        <Show when={error()}>
          <p role="alert" class="text-destructive truncate">
            {error()}
          </p>
        </Show>
      </TableCell>

      <TableCell class="w-[11rem] py-2">
        <time
          class="text-muted-foreground text-xs whitespace-nowrap tabular-nums"
          dateTime={new Date(
            props.task.createdAt,
          ).toISOString()}
        >
          {new Date(props.task.createdAt).toLocaleString()}
        </time>
      </TableCell>

      <TableCell class="w-[15rem] py-2 text-right">
        <div class="flex flex-nowrap justify-end gap-1">
          <Show when={file()?.canPause}>
            <Button
              size="sm"
              variant="outline"
              class="h-7 px-2 text-xs"
              disabled={pending()}
              onClick={() =>
                void action(() =>
                  app.pauseFile(
                    file()!.message.fid!,
                    props.task.peerId,
                  ),
                )
              }
            >
              {t("tasks.pause")}
            </Button>
          </Show>
          <Show
            when={
              file() &&
              ["paused", "failed"].includes(
                props.task.status,
              )
            }
          >
            <Button
              size="sm"
              variant="outline"
              class="h-7 px-2 text-xs"
              disabled={!online() || pending()}
              onClick={() => void action(resume)}
            >
              {t("tasks.resume")}
            </Button>
          </Show>
          <Show when={awaitingLocalApproval()}>
            <Button
              size="sm"
              class="h-7 px-2 text-xs"
              onClick={() =>
                app.approveSpeedTest(props.task.peerId)
              }
            >
              {t("speed_test.accept")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              class="h-7 px-2 text-xs"
              onClick={() =>
                app.declineSpeedTest(props.task.peerId)
              }
            >
              {t("speed_test.decline")}
            </Button>
          </Show>
          <Show
            when={
              speed()?.status === "running" &&
              !awaitingLocalApproval()
            }
          >
            <Button
              size="sm"
              variant="outline"
              class="h-7 px-2 text-xs"
              onClick={cancelSpeed}
            >
              {t("speed_test.cancel")}
            </Button>
          </Show>
          <Button
            size="sm"
            variant="ghost"
            class="h-7 px-2 text-xs"
            onClick={() =>
              props.onInspect(
                props.task.peerId,
                props.task.kind === "speed-test",
              )
            }
          >
            {t("tasks.inspect")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
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
      return true;
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
      class="flex min-w-0 flex-col gap-3"
      aria-label={t("tasks.title")}
    >
      <p class="text-muted-foreground text-sm whitespace-normal">
        {t("tasks.description")}
      </p>

      <div
        class="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t("tasks.filters_label")}
      >
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

        <p class="text-muted-foreground ml-auto text-xs">
          {t("tasks.count", {
            active: app.tasks.activeCount(),
            total: app.tasks.tasks().length,
          })}
        </p>
        <Button
          size="sm"
          variant="ghost"
          class="h-8"
          disabled={!app.tasks.tasks().some(isFinishedTask)}
          onClick={app.tasks.clearFinished}
        >
          {t("tasks.clear_finished")}
        </Button>
      </div>

      <Show
        when={filtered().length}
        fallback={
          <div class="rounded-md border">
            <p class="text-muted-foreground py-16 text-center text-sm">
              {t("tasks.empty")}
            </p>
          </div>
        }
      >
        <div class="overflow-x-auto rounded-md border">
          <Table
            class="min-w-[67rem] table-fixed"
            aria-label={t("tasks.title")}
          >
            <TableHeader class="bg-muted/40">
              <TableRow class="hover:bg-transparent">
                <TableHead class="h-8 w-[18rem]">
                  {t("tasks.columns.task")}
                </TableHead>
                <TableHead class="h-8 w-[7rem]">
                  {t("tasks.columns.status")}
                </TableHead>
                <TableHead class="h-8 w-[16rem]">
                  {t("tasks.columns.detail")}
                </TableHead>
                <TableHead class="h-8 w-[11rem]">
                  {t("tasks.columns.time")}
                </TableHead>
                <TableHead class="h-8 w-[15rem] text-right">
                  {t("tasks.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <For
                each={filtered()
                  .slice(0, limit())
                  .map((task) => task.id)}
              >
                {(id) => (
                  <Show
                    when={app.tasks
                      .tasks()
                      .find((task) => task.id === id)}
                  >
                    {(task) => (
                      <TaskRow
                        task={task()}
                        onInspect={props.onInspect}
                      />
                    )}
                  </Show>
                )}
              </For>
            </TableBody>
          </Table>
        </div>

        <Show when={filtered().length > limit()}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLimit((value) => value + 30)}
          >
            {t("tasks.show_more")}
          </Button>
        </Show>
      </Show>

      <p class="text-muted-foreground text-xs">
        {t("tasks.retention_note")}
      </p>
    </section>
  );
}
