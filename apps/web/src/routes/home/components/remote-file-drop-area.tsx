import {
  createSignal,
  createEffect,
  onCleanup,
  type ParentProps,
} from "solid-js";
import { toast } from "solid-sonner";
import DropArea from "@/components/drop-area";
import { t } from "@/i18n";
import { handleDropItems } from "@/libs/utils/process-file";
import { CLIPBOARD_MAX_ENTRIES } from "@/libs/domain/protocol/clipboard";
import type {
  RemotePointer,
  PointerPosition,
} from "@/libs/domain/remote-control/pointer";
import type { RemoteFileDrop } from "@/libs/application/remote-file-drop";

export function RemoteFileDropArea(
  props: ParentProps<{
    active: boolean;
    enabled: boolean;
    clientId?: string;
    control?: RemotePointer;
    service?: Pick<RemoteFileDrop, "drop"> &
      Partial<Pick<RemoteFileDrop, "hover" | "leave">>;
    point(event: DragEvent): PointerPosition | undefined;
  }>,
) {
  const [busy, setBusy] = createSignal(false);
  let operation: AbortController | undefined;
  let cancelHover: (() => void) | undefined;
  let hoverErrorShown = false;
  const leave = () => {
    cancelHover?.();
    cancelHover = undefined;
    hoverErrorShown = false;
  };
  onCleanup(() => {
    leave();
    operation?.abort();
  });
  const allowed = () =>
    props.active &&
    props.enabled &&
    !!props.service &&
    !!props.clientId &&
    !!props.control?.fileDropTarget();
  createEffect(() => {
    if (!allowed()) leave();
  });
  const hover = (event: DragEvent) => {
    const point = props.point(event);
    if (!allowed() || busy() || !point) {
      leave();
      return;
    }
    const { clientId, control, service } = props;
    cancelHover = () =>
      service?.leave?.(clientId!, control!);
    const hovering = service?.hover?.(
      clientId!,
      control!,
      point,
      [
        ...new Set(
          Array.from(event.dataTransfer?.items ?? [])
            .filter((item) => item.kind === "file")
            .map((item) => item.type),
        ),
      ].slice(0, 16),
    );
    void hovering?.catch((error: unknown) => {
      if (
        !hoverErrorShown &&
        !(
          error instanceof Error &&
          error.name === "AbortError"
        )
      ) {
        hoverErrorShown = true;
        toast.error(t("remote_control.file_drop.failed"), {
          description:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    });
  };
  const drop = async (event: DragEvent) => {
    const data = event.dataTransfer;
    const point = props.point(event);
    if (!allowed() || busy() || !data || !point) {
      leave();
      return;
    }
    const life = new AbortController();
    operation = life;
    setBusy(true);
    const id = toast.loading(
      t("common.notification.processing_files"),
      {
        duration: Infinity,
        action: {
          label: t("common.action.cancel"),
          onClick: () => life.abort(),
        },
      },
    );
    let handedToTask = false;
    const prepared = (hasTask: boolean) => {
      handedToTask = hasTask;
      if (hasTask) toast.dismiss(id);
    };
    try {
      await props.service!.drop(
        props.clientId!,
        props.control!,
        point,
        (signal, maxFileBytes) => {
          // This callback runs synchronously in the trusted drop event.
          return data.items?.length
            ? handleDropItems(data.items, signal, {
                maxBytes: maxFileBytes,
                maxEntries: CLIPBOARD_MAX_ENTRIES,
              })
            : Promise.resolve(Array.from(data.files));
        },
        life.signal,
        prepared,
      );
      if (!handedToTask)
        toast.success(
          t("remote_control.file_drop.completed"),
        );
    } catch (error) {
      if (
        !life.signal.aborted &&
        !handedToTask &&
        !(
          error instanceof Error &&
          error.name === "AbortError"
        )
      )
        toast.error(t("remote_control.file_drop.failed"), {
          description:
            error instanceof Error
              ? error.message
              : String(error),
        });
    } finally {
      toast.dismiss(id);
      if (operation === life) operation = undefined;
      hoverErrorShown = false;
      setBusy(false);
    }
  };
  return (
    <DropArea
      class="absolute inset-0 z-10"
      style={{
        "pointer-events": props.active ? "auto" : "none",
      }}
      disabled={!allowed() || busy()}
      onDragOver={hover}
      onDragCancel={leave}
      onDrop={(event) => void drop(event)}
    >
      {props.children}
    </DropArea>
  );
}
