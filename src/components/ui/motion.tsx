import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  splitProps,
  untrack,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  animate,
  type AnimationOptions,
  type AnimationPlaybackControls,
  type DOMKeyframesDefinition,
} from "motion";
import { animate as animateNative } from "motion/mini";
import { createReducedMotion } from "@/libs/hooks/reduced-motion";

export type MotionTarget = DOMKeyframesDefinition;
export type MotionTransition = AnimationOptions;
type ExitHandler = () => Promise<unknown>;
const PresenceContext = createContext<{
  present(): boolean;
  register(exit: ExitHandler): () => void;
}>();

/** Solid needs an explicit condition so children remain owned until exit ends. */
export function AnimatePresence(
  props: ParentProps<{
    when: boolean;
    onExitComplete?: () => void;
  }>,
) {
  const reduced = createReducedMotion();
  const [mounted, setMounted] = createSignal(props.when);
  const exits = new Set<ExitHandler>();
  let version = 0;
  const context = {
    present: () => props.when,
    register(exit: ExitHandler) {
      exits.add(exit);
      return () => {
        exits.delete(exit);
      };
    },
  };
  createEffect(() => {
    const current = ++version;
    const finishExit = () => {
      if (
        current !== version ||
        props.when ||
        !untrack(mounted)
      )
        return;
      props.onExitComplete?.();
      if (current === version) setMounted(false);
    };
    if (props.when) setMounted(true);
    else if (!untrack(mounted)) return;
    else if (reduced()) finishExit();
    else {
      const pending = untrack(() =>
        [...exits].map((exit) => exit()),
      );
      if (!pending.length) finishExit();
      else
        void Promise.allSettled(pending).then(finishExit);
    }
  });
  onCleanup(() => {
    version++;
    exits.clear();
  });
  return (
    <PresenceContext.Provider value={context}>
      <Show when={mounted()}>{props.children}</Show>
    </PresenceContext.Provider>
  );
}

type MotionOptions = {
  /** CSS keyframes with synchronous WAAPI startup, independent of the opener's RAF. */
  native?: boolean;
  initial?: MotionTarget | false;
  animate?: MotionTarget;
  exit?: MotionTarget;
  transition?: MotionTransition;
  /** Opt into the enclosing createLayoutTransition scope. */
  layout?: boolean;
  layoutId?: string;
};
type HTMLTag = keyof HTMLElementTagNameMap &
  keyof JSX.IntrinsicElements;
export type MotionProps<Tag extends HTMLTag> =
  JSX.IntrinsicElements[Tag] & MotionOptions;

function createMotionComponent(tag: HTMLTag) {
  return (
    props: JSX.HTMLAttributes<HTMLElement> & MotionOptions,
  ) => {
    const [local, rest] = splitProps(props, [
      "native",
      "initial",
      "animate",
      "exit",
      "transition",
      "layout",
      "layoutId",
      "ref",
    ]);
    const id = createUniqueId();
    const reduced = createReducedMotion();
    const presence = useContext(PresenceContext);
    let element: HTMLElement | undefined;
    let controls: AnimationPlaybackControls | undefined;
    let first = true;
    const useNative = () =>
      local.native &&
      typeof element?.animate === "function";
    const play = (target: MotionTarget) => {
      if (!element) return Promise.resolve();
      controls?.stop();
      const run = useNative() ? animateNative : animate;
      controls = run(element, target, {
        duration: 0.2,
        ease: "easeOut",
        ...local.transition,
        ...(reduced()
          ? {
              ...(useNative()
                ? {}
                : { type: "tween" as const }),
              duration: 0,
              delay: 0,
              repeat: 0,
            }
          : {}),
      });
      return controls.finished;
    };
    const unregister = presence?.register(() =>
      local.exit ? play(local.exit) : Promise.resolve(),
    );
    createEffect(() => {
      if (presence && !presence.present()) return;
      const target = local.animate;
      const initial = local.initial;
      if (!target) return;
      // Explicit keyframes give the first frame its initial styles before paint.
      const keyframes: MotionTarget = { ...target };
      if (first && initial && !reduced()) {
        for (const key of Object.keys(target)) {
          const from = (initial as Record<string, unknown>)[
            key
          ];
          const to = (target as Record<string, unknown>)[
            key
          ];
          if (from !== undefined && !Array.isArray(to)) {
            (keyframes as Record<string, unknown>)[key] = [
              from,
              to,
            ];
          }
        }
      }
      // initial={false} skips the first entrance, but later state changes animate.
      if (first && initial === false && element) {
        const run = useNative() ? animateNative : animate;
        controls = run(element, target, {
          duration: 0,
        });
        controls.complete();
      } else void play(keyframes);
      first = false;
    });
    onCleanup(() => {
      unregister?.();
      controls?.cancel();
    });
    return (
      <Dynamic
        component={tag}
        {...rest}
        ref={(node: HTMLElement) => {
          element = node;
          if (typeof local.ref === "function")
            local.ref(node);
        }}
        data-motion-layout={
          local.layout ? (local.layoutId ?? id) : undefined
        }
        inert={
          presence && !presence.present()
            ? true
            : rest.inert
        }
        aria-hidden={
          presence && !presence.present()
            ? true
            : rest["aria-hidden"]
        }
      />
    );
  };
}

type MotionComponents = {
  [Tag in HTMLTag]: (
    props: MotionProps<Tag>,
  ) => JSX.Element;
};
const components = new Map<
  string,
  ReturnType<typeof createMotionComponent>
>();
export const Motion = new Proxy({} as MotionComponents, {
  get(_, tag: string) {
    if (!components.has(tag))
      components.set(
        tag,
        createMotionComponent(tag as HTMLTag),
      );
    return components.get(tag);
  },
});
