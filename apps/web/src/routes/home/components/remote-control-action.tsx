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
import { useVideoDisplay } from "./video-display";
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
  createEffect(() => {
    const c = control();
    const update = () =>
      setState(c?.state() ?? "unavailable");
    update();
    c?.addEventListener("change", update);
    onCleanup(() =>
      c?.removeEventListener("change", update),
    );
  });
  return { control, state };
}

export function RemoteControlAction(props: {
  control: ControlAction;
  state: PointerState;
  onRequest?(request: () => void): void;
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
          : props.state === "unavailable"
            ? "remote_control.reconnecting"
            : "remote_control.request",
    );
  return (
    <MeetingTileAction
      label={label()}
      active={controlling()}
      order={0}
      disabled={props.state === "unavailable"}
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
        } else if (props.state !== "unavailable")
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
  );
}
