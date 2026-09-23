import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import {
  Camera,
  CameraOff,
  ChevronUp,
  ChevronDown,
  Grid2X2,
  Mic,
  MicOff,
  MonitorUp,
  Plus,
  PhoneOff,
  LogIn,
  LoaderCircle,
  PictureInPicture2,
  PanelTopOpen,
  RectangleEllipsis,
  ScreenShareOff,
  Volume2,
  VolumeX,
} from "lucide-solid";
import { t } from "@/i18n";
import type { createMeetingMediaController } from "./meeting-media";
import { MeetingCollapseButton } from "./meeting-collapse-button";
import {
  MeetingDeviceMenu,
  type MeetingDeviceControls,
} from "./meeting-device-menu";
export type { MeetingDeviceControls } from "./meeting-device-menu";

type MediaControls = ReturnType<
  typeof createMeetingMediaController
>;

export interface MeetingPipControls {
  supported: Accessor<boolean>;
  active: Accessor<boolean>;
  busy: Accessor<boolean>;
  automatic: Accessor<boolean>;
  setAutomatic(value: boolean): void;
  toggle(): void;
  returnToMeeting(): void;
}

export function MeetingControls(props: {
  media: MediaControls;
  playingAudio: boolean;
  hasAudio: boolean;
  onToggleAudio(): void;
  spotlight: boolean;
  onToggleLayout(): void;
  joined: boolean;
  onLeave(): void;
  onJoin?(): void;
  joining?: boolean;
  devices?: MeetingDeviceControls;
  pip?: MeetingPipControls;
  compact?: boolean;
  collapsed?: boolean;
  onCollapsedChange?(collapsed: boolean): void;
}) {
  const [menu, setMenu] = createSignal<
    "audio" | "camera" | "pip" | null
  >(null);
  const displayedMenu = createMemo<"audio" | "camera">(
    (previous) =>
      menu() === "audio" || menu() === "camera"
        ? (menu() as "audio" | "camera")
        : previous,
    "audio",
  );
  let footer!: HTMLElement;
  let audioToggle: HTMLButtonElement | undefined;
  let cameraToggle: HTMLButtonElement | undefined;
  let pipToggle: HTMLButtonElement | undefined;
  let collapseToggle: HTMLButtonElement | undefined;
  let restoreToggle: HTMLButtonElement | undefined;
  const toggleCollapsed = (collapsed: boolean) => {
    props.onCollapsedChange?.(collapsed);
    queueMicrotask(() => {
      (collapsed ? restoreToggle : collapseToggle)?.focus();
    });
  };
  const closeMenu = (restoreFocus = false) => {
    const toggle =
      menu() === "audio"
        ? audioToggle
        : menu() === "camera"
          ? cameraToggle
          : pipToggle;
    setMenu(null);
    if (restoreFocus) toggle?.focus();
  };
  const toggleMenu = (next: "audio" | "camera" | "pip") => {
    if (menu() === next) closeMenu();
    else {
      setMenu(next);
      if (next !== "pip") props.devices?.refresh();
    }
  };
  createEffect(() => {
    if (props.collapsed) setMenu(null);
  });
  createEffect(() => {
    if (!menu()) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !footer.contains(event.target) &&
        !(
          event.target instanceof Element &&
          event.target.closest(
            "[data-meeting-device-popup]",
          )
        )
      )
        closeMenu();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Let the select close its own portal before closing the device menu.
        if (
          footer.querySelector(
            '[role="combobox"][aria-expanded="true"]',
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      }
    };
    const document = footer.ownerDocument;
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    });
  });
  return (
    <>
      <AnimatePresence when={!props.collapsed}>
        <Motion.footer
          native
          ref={footer}
          class="meeting-controls"
          initial={{
            opacity: 0,
            transform: "translateY(12px)",
          }}
          animate={{
            opacity: 1,
            transform: "translateY(0px)",
          }}
          exit={{
            opacity: 0,
            transform: "translateY(12px)",
          }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          classList={{
            "is-device-menu-open": Boolean(menu()),
          }}
          aria-label={t("meeting.controls")}
          inert={props.collapsed}
          aria-hidden={props.collapsed}
        >
          <AnimatePresence
            when={Boolean(
              props.devices && menu() && menu() !== "pip",
            )}
          >
            <MeetingDeviceMenu
              mode={displayedMenu()}
              devices={props.devices!}
              microphoneBusy={props.media.microphoneBusy()}
              cameraBusy={props.media.cameraBusy()}
              playingAudio={props.playingAudio}
              hasAudio={props.hasAudio}
              onToggleAudio={props.onToggleAudio}
              onClose={() => closeMenu(true)}
            />
          </AnimatePresence>
          <AnimatePresence
            when={menu() === "pip" && Boolean(props.pip)}
          >
            <Motion.section
              id="meeting-pip-settings"
              class="meeting-device-menu meeting-pip-settings"
              aria-label={t("meeting.pip_settings")}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{
                duration: 0.18,
                ease: "easeOut",
              }}
            >
              <Switch
                checked={props.pip?.automatic()}
                onChange={(value) =>
                  props.pip?.setAutomatic(value)
                }
                class="flex items-center justify-between gap-4"
              >
                <SwitchLabel>
                  {t("meeting.pip_automatic")}
                </SwitchLabel>
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>
              <p class="meeting-device-hint">
                {t("meeting.pip_automatic_hint")}
              </p>
            </Motion.section>
          </AnimatePresence>
          <div class="meeting-controls-group">
            <div class="meeting-device-control">
              <Show when={props.devices}>
                <button
                  ref={audioToggle}
                  type="button"
                  class="meeting-device-toggle"
                  aria-label={t("meeting.audio_devices")}
                  title={t("meeting.audio_devices")}
                  aria-expanded={menu() === "audio"}
                  aria-controls="meeting-device-menu"
                  onClick={() => toggleMenu("audio")}
                >
                  <ChevronUp />
                </button>
              </Show>
              <button
                type="button"
                class="meeting-control"
                classList={{
                  "is-off": !props.media.microphoneOn(),
                }}
                disabled={props.media.microphoneBusy()}
                aria-pressed={props.media.microphoneOn()}
                aria-label={
                  props.media.microphoneOn()
                    ? t("meeting.mute_microphone")
                    : t("meeting.enable_microphone")
                }
                title={
                  props.media.microphoneOn()
                    ? t("meeting.mute_microphone")
                    : t("meeting.enable_microphone")
                }
                onClick={() =>
                  void props.media.toggleMicrophone()
                }
              >
                <Show
                  when={props.media.microphoneOn()}
                  fallback={<MicOff />}
                >
                  <Mic />
                </Show>
                <span>{t("meeting.microphone")}</span>
              </button>
            </div>
            <div class="meeting-device-control">
              <Show when={props.devices}>
                <button
                  ref={cameraToggle}
                  type="button"
                  class="meeting-device-toggle"
                  aria-label={t("meeting.camera_devices")}
                  title={t("meeting.camera_devices")}
                  aria-expanded={menu() === "camera"}
                  aria-controls="meeting-device-menu"
                  onClick={() => toggleMenu("camera")}
                >
                  <ChevronUp />
                </button>
              </Show>
              <button
                type="button"
                class="meeting-control"
                classList={{
                  "is-off": !props.media.cameraOn(),
                }}
                disabled={props.media.cameraBusy()}
                aria-pressed={props.media.cameraOn()}
                aria-label={
                  props.media.cameraOn()
                    ? t("meeting.disable_camera")
                    : t("meeting.enable_camera")
                }
                title={
                  props.media.cameraOn()
                    ? t("meeting.disable_camera")
                    : t("meeting.enable_camera")
                }
                onClick={() =>
                  void props.media.toggleCamera()
                }
              >
                <Show
                  when={props.media.cameraOn()}
                  fallback={<CameraOff />}
                >
                  <Camera />
                </Show>
                <span>{t("meeting.camera")}</span>
              </button>
            </div>
            <button
              type="button"
              class="meeting-control"
              classList={{
                "is-active": props.media.sharing(),
              }}
              disabled={props.media.sharingBusy()}
              aria-pressed={props.media.sharing()}
              aria-label={
                props.media.sharing()
                  ? t("meeting.stop_sharing")
                  : t("meeting.share_screen")
              }
              title={
                props.media.sharing()
                  ? t("meeting.stop_sharing")
                  : t("meeting.share_screen")
              }
              onClick={() =>
                void props.media.toggleSharing()
              }
            >
              <Show
                when={props.media.sharing()}
                fallback={<MonitorUp />}
              >
                <ScreenShareOff />
              </Show>
              <span>
                {props.media.sharing()
                  ? t("meeting.stop_sharing")
                  : t("meeting.share_screen")}
              </span>
            </button>
            <Show
              when={props.media.sharing() && !props.compact}
            >
              <button
                type="button"
                class="meeting-control"
                disabled={props.media.sharingBusy()}
                aria-label={t("meeting.add_sharing")}
                title={t("meeting.add_sharing")}
                onClick={() =>
                  void props.media.addSharing()
                }
              >
                <Plus />
                <span>{t("meeting.add_sharing")}</span>
              </button>
            </Show>
            <span class="meeting-control-divider" />
            <Show when={!props.devices}>
              <button
                type="button"
                class="meeting-control"
                disabled={!props.hasAudio}
                aria-pressed={props.playingAudio}
                onClick={props.onToggleAudio}
                aria-label={
                  props.playingAudio
                    ? t("video.global_mute")
                    : t("video.global_unmute")
                }
                title={
                  props.playingAudio
                    ? t("video.global_mute")
                    : t("video.global_unmute")
                }
              >
                <Show
                  when={props.playingAudio}
                  fallback={<VolumeX />}
                >
                  <Volume2 />
                </Show>
                <span>{t("meeting.sound")}</span>
              </button>
            </Show>
            <Show when={!props.compact}>
              <button
                type="button"
                class="meeting-control"
                aria-pressed={props.spotlight}
                aria-label={
                  props.spotlight
                    ? t("meeting.grid_layout")
                    : t("meeting.focus_layout")
                }
                title={
                  props.spotlight
                    ? t("meeting.grid_layout")
                    : t("meeting.focus_layout")
                }
                onClick={props.onToggleLayout}
              >
                <Show
                  when={props.spotlight}
                  fallback={<RectangleEllipsis />}
                >
                  <Grid2X2 />
                </Show>
                <span>{t("meeting.layout")}</span>
              </button>
            </Show>
            <Show when={props.pip}>
              {(pip) => (
                <div class="meeting-device-control">
                  <Show when={!props.compact}>
                    <button
                      ref={pipToggle}
                      type="button"
                      class="meeting-device-toggle"
                      disabled={!pip().supported()}
                      aria-label={t("meeting.pip_settings")}
                      title={t("meeting.pip_settings")}
                      aria-expanded={menu() === "pip"}
                      aria-controls="meeting-pip-settings"
                      onClick={() => toggleMenu("pip")}
                    >
                      <ChevronUp />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="meeting-control"
                    classList={{
                      "is-active": pip().active(),
                    }}
                    disabled={
                      !pip().supported() ||
                      (pip().busy() && !pip().active())
                    }
                    aria-pressed={
                      props.compact
                        ? undefined
                        : pip().active()
                    }
                    aria-label={t(
                      props.compact
                        ? "meeting.pip_return"
                        : pip().active()
                          ? "common.action.exit_picture_in_picture"
                          : "common.action.picture_in_picture",
                    )}
                    title={t(
                      !pip().supported()
                        ? "meeting.pip_unsupported"
                        : props.compact
                          ? "meeting.pip_return"
                          : pip().active()
                            ? "common.action.exit_picture_in_picture"
                            : "common.action.picture_in_picture",
                    )}
                    onClick={() => {
                      closeMenu();
                      if (props.compact)
                        pip().returnToMeeting();
                      else pip().toggle();
                    }}
                  >
                    <Show
                      when={props.compact}
                      fallback={<PictureInPicture2 />}
                    >
                      <PanelTopOpen />
                    </Show>
                    <span>
                      {t(
                        props.compact
                          ? "meeting.pip_return"
                          : "common.action.picture_in_picture",
                      )}
                    </span>
                  </button>
                </div>
              )}
            </Show>
          </div>
          <button
            type="button"
            class="meeting-leave"
            classList={{ "meeting-join": !props.joined }}
            disabled={
              props.joining ||
              (!props.joined && !props.onJoin)
            }
            onClick={() =>
              props.joined
                ? props.onLeave()
                : props.onJoin?.()
            }
            aria-label={t(
              props.joining
                ? "app_menu.joining"
                : props.joined
                  ? "meeting.leave_room"
                  : "meeting.join_room",
            )}
            title={t(
              props.joined
                ? "meeting.leave_room"
                : "meeting.join_room",
            )}
          >
            <Show
              when={!props.joining}
              fallback={
                <LoaderCircle class="animate-spin" />
              }
            >
              <Show
                when={props.joined}
                fallback={<LogIn />}
              >
                <PhoneOff />
              </Show>
            </Show>
            <span>
              {t(
                props.joining
                  ? "app_menu.joining"
                  : props.joined
                    ? "meeting.leave_room"
                    : "meeting.join_room",
              )}
            </span>
          </button>
          <Show when={props.onCollapsedChange}>
            <button
              ref={collapseToggle}
              type="button"
              class="meeting-icon-button meeting-toolbar-toggle"
              aria-label={t("meeting.hide_toolbar")}
              title={t("meeting.hide_toolbar")}
              aria-expanded="true"
              onClick={() => toggleCollapsed(true)}
            >
              <ChevronDown />
            </button>
          </Show>
        </Motion.footer>
      </AnimatePresence>
      <AnimatePresence
        when={Boolean(
          props.collapsed && props.onCollapsedChange,
        )}
      >
        <Motion.div
          native
          class="meeting-collapsed-controls"
          initial={{
            opacity: 0,
            transform: "translateY(8px)",
          }}
          animate={{
            opacity: 1,
            transform: "translateY(0px)",
          }}
          exit={{
            opacity: 0,
            transform: "translateY(8px)",
          }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <MeetingCollapseButton
            ref={(button) => {
              restoreToggle = button;
            }}
            expanded={false}
            label={t("meeting.show_toolbar")}
            disabled={!props.collapsed}
            onToggle={() => toggleCollapsed(false)}
          />
        </Motion.div>
      </AnimatePresence>
    </>
  );
}
