import {
  ArrowUpRight,
  GripHorizontal,
  X,
} from "lucide-solid";
import { t } from "@/i18n";
import { Motion } from "@/components/ui/motion";

export function NativePipBar(props: {
  active: boolean;
  height: number;
  name: string;
  onDrag(): void;
  onRestore(): void;
  transitioning?: boolean;
}) {
  return (
    <Motion.div
      native
      initial={{
        opacity: 0,
        transform: "translateY(-6px)",
      }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0 }}
      transition={{
        duration: 0.28,
        ease: [0.22, 1, 0.36, 1],
      }}
      class="native-pip-bar flex shrink-0 items-center gap-1 px-2"
      style={{ height: `${props.height}px` }}
      classList={{
        // The system caption is already back when active becomes false. Do not
        // keep a second caption visible while layout finishes restoring.
        "pointer-events-none invisible absolute inset-x-0 top-0":
          !props.active,
      }}
      inert={!props.active}
    >
      <div
        class="flex min-w-0 flex-1 cursor-move items-center gap-2
          self-stretch"
        onPointerDown={(event) => {
          if (event.button === 0 && !props.transitioning) {
            event.preventDefault();
            props.onDrag();
          }
        }}
        onDblClick={props.onRestore}
      >
        <GripHorizontal
          class="text-muted-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        <span class="truncate text-xs font-medium">
          {props.name}
        </span>
      </div>
      <button
        type="button"
        class="meeting-icon-button"
        title={t("meeting.pip_return")}
        aria-label={t("meeting.pip_return")}
        onClick={props.onRestore}
      >
        <ArrowUpRight />
      </button>
      <button
        type="button"
        class="meeting-icon-button"
        title={t("common.action.exit_picture_in_picture")}
        aria-label={t(
          "common.action.exit_picture_in_picture",
        )}
        onClick={props.onRestore}
      >
        <X />
      </button>
    </Motion.div>
  );
}
