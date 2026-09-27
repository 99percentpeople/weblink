import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Ref,
  Show,
  splitProps,
} from "solid-js";
import { JSX } from "solid-js/jsx-runtime";
import {
  GridItemHTMLElement,
  GridStack as GridStackC,
  GridStackNode,
  GridStackOptions,
  GridStackPosition,
} from "gridstack";
import { GridStackContext } from "./grid-context";
import { Dynamic } from "solid-js/web";
import clsx from "clsx";

export type GridStackRef = {
  compact: () => void;
} & HTMLElement;

type GridStackProps<
  T extends keyof JSX.IntrinsicElements = "div",
> = Omit<JSX.IntrinsicElements[T], "ref"> & {
  as?: T;
  options?: GridStackOptions;
  ref?: Ref<GridStackRef>;
  onLayoutChange?: (
    event: Event,
    layout: GridStackNode[],
  ) => void;
  onRemove?: (event: Event, items: GridStackNode[]) => void;
  onDragStatusChange?: (
    event: Event,
    item: GridItemHTMLElement,
    drag: boolean,
  ) => void;
};

export const layout: Record<string, GridStackPosition> = {};

export function GridStack(props: GridStackProps) {
  const [local, other] = splitProps(props, [
    "as",
    "options",
    "children",
    "class",
    "ref",
    "onLayoutChange",
    "onRemove",
  ]);
  const [element, setElement] = createSignal<
    HTMLElement | undefined
  >(undefined);
  const [grid, setGrid] = createSignal<GridStackC>();

  createRefContent(local.ref, () => {
    const el = element() as GridStackRef;
    el.compact = () => {
      const g = grid();
      if (g) {
        g.compact();
      }
    };
    return el;
  });

  onMount(() => {
    const el = element();
    if (el) {
      const g = GridStackC.init(props.options, el);

      g.on("change", (event, items) => {
        props?.onLayoutChange?.(event, items);
      });

      g.on("removed", (event, items) => {
        props.onRemove?.(event, items);
        items.forEach((item) => {
          if (item.id) {
            delete layout[item.id];
          }
        });
      });

      g.on("dragstart", (event, item) => {
        // find if the is removable
        const isRemovable = item?.classList.contains(
          "grid-stack-non-removable",
        );
        props.onDragStatusChange?.(
          event,
          item,
          !isRemovable,
        );
      });

      g.on("dragstop", (event, item) => {
        props.onDragStatusChange?.(event, item, false);
      });

      setGrid(g);

      createEffect(() => {
        if (props.options) {
          g.cellHeight(props.options.cellHeight, true);
          if (typeof props.options.column === "number") {
            g.column(props.options.column);
          }
          if (props.options.float !== undefined) {
            g.float(props.options.float);
          }
        }
      });

      onCleanup(() => {
        const g = grid();
        if (g) {
          g.destroy(false);
          setGrid(undefined);
        }
      });
    }
  });

  return (
    <Dynamic
      component={local.as ?? "div"}
      ref={(ref) => setElement(ref)}
      class={clsx(local.class, "grid-stack")}
      {...other}
    >
      <Show when={grid()}>
        {(grid) => (
          <GridStackContext.Provider
            value={{
              grid: grid(),
            }}
          >
            {props.children}
          </GridStackContext.Provider>
        )}
      </Show>
    </Dynamic>
  );
}

function createRefContent<T>(
  ref: Ref<T> | undefined,
  createRef: () => T,
) {
  createEffect(() => {
    // Skip if ref is undefined
    if (!ref) return;

    // Handle both function refs and value refs
    if (typeof ref === "function") {
      (ref as (val: T) => void)(createRef());
    } else {
      ref = createRef();
    }
  });
}
