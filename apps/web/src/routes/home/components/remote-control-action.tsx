import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import { MousePointer2, Square, X } from "lucide-solid";
import { sessionService } from "@/libs/application/session-service";
import type {
  RemotePointer,
  PointerState,
} from "@/libs/domain/remote-control/pointer";
import { t } from "@/i18n";
import { useVideoDisplay } from "@/routes/home/components/video-display-context";
import { MeetingTileAction } from "./meeting-tile-actions";

export function createVideoRemoteControl() {
  const video = useVideoDisplay();
  const control = createMemo(() => {
    const track = video.videoTrack();
    return track
      ? sessionService.getRemoteControl(track)
      : undefined;
  });
  return createControlState(control);
}

export function createScreenCloseAction(
  clientId: Accessor<string | undefined>,
  pointer: Accessor<RemotePointer | undefined>,
) {
  const screen = createControlState(() => {
    const id = clientId();
    return id
      ? sessionService.getScreenControl(id)
      : undefined;
  });
  return createMemo(() => {
    screen.revision();
    const request = screen.control();
    const control = pointer();
    return control && request?.canClose(control)
      ? () => request.closeScreen(control)
      : undefined;
  });
}
type ControlAction = Pick<
  RemotePointer,
  | "state"
  | "request"
  | "cancel"
  | "addEventListener"
  | "removeEventListener"
>;
export function createControlState<T extends ControlAction>(
  control: Accessor<T | undefined>,
) {
  const [state, setState] =
    createSignal<PointerState>("unavailable");
  const [revision, setRevision] = createSignal(0);
  createEffect(() => {
    const c = control();
    const update = () => {
      setState(c?.state() ?? "unavailable");
      setRevision((value) => value + 1);
    };
    update();
    c?.addEventListener("change", update);
    onCleanup(() =>
      c?.removeEventListener("change", update),
    );
  });
  return { control, state, revision };
}

export function RemoteControlAction(props: {
  control: ControlAction;
  state: PointerState;
  onRequest?(request: () => void): void;
  onCloseScreen?(): void;
}) {
  const controlling = () =>
    props.state === "active" ||
    props.state === "activating";
  const label = () =>
    t(
      props.state === "requesting"
        ? "remote_control.cancel"
        : controlling()
          ? "remote_control.end"
          : props.state === "busy"
            ? "remote_control.busy"
            : props.state === "unavailable"
              ? "remote_control.reconnecting"
              : "remote_control.request",
    );
  return (
    <>
      <MeetingTileAction
        label={label()}
        active={controlling()}
        order={0}
        disabled={
          props.state === "unavailable" ||
          props.state === "busy"
        }
        onAction={() => {
          if (props.state === "viewing") {
            const control = props.control;
            const request = () => {
              if (
                props.control === control &&
                control.state() === "viewing"
              )
                control.request();
            };
            if (props.onRequest) props.onRequest(request);
            else request();
          } else if (
            props.state !== "unavailable" &&
            props.state !== "busy"
          )
            props.control.cancel();
        }}
      >
        <Show
          when={props.state === "requesting"}
          fallback={
            <Show
              when={controlling()}
              fallback={<MousePointer2 />}
            >
              <Square />
            </Show>
          }
        >
          <X />
        </Show>
      </MeetingTileAction>
      <Show when={props.onCloseScreen}>
        <MeetingTileAction
          label={t("remote_control.close_screen")}
          order={1}
          onAction={() => props.onCloseScreen?.()}
        >
          <X />
        </MeetingTileAction>
      </Show>
    </>
  );
}
