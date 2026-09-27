import {
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  JSX,
  mergeProps,
  onCleanup,
  onMount,
  splitProps,
} from "solid-js";
import { useGridStackContext } from "./grid-context";
import type {
  GridStackNode,
  GridStackPosition,
} from "gridstack";
import { Dynamic } from "solid-js/web";
import clsx from "clsx";
import { layout } from "./grid";
type GridItemProps<
  T extends keyof JSX.IntrinsicElements = "div",
> = {
  as?: T;
  // GridStack specific attributes
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  autoPosition?: boolean;
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  locked?: boolean;
  noResize?: boolean;
  noMove?: boolean;
  noRemovable?: boolean;
} & JSX.IntrinsicElements[T];

export function GridItem(props: GridItemProps) {
  const [local, other] = splitProps(props, [
    "as",
    "class",
    "children",
    "x",
    "y",
    "w",
    "h",
    "autoPosition",
    "minW",
    "maxW",
    "minH",
    "maxH",
    "locked",
    "noResize",
    "noMove",
    "noRemovable",
  ]);

  const ctx = useGridStackContext();
  const [elementRef, setElementRef] = createSignal<
    HTMLDivElement | undefined
  >(undefined);

  const gridItemOptions = createMemo(() => {
    const options: GridStackNode = {
      x: local.x,
      y: local.y,
      w: local.w,
      h: local.h,
      autoPosition: local.autoPosition,
      minW: local.minW,
      maxW: local.maxW,
      minH: local.minH,
      maxH: local.maxH,
      locked: local.locked,
      noResize: local.noResize,
      noMove: local.noMove,
    };

    Object.keys(options).forEach((key) => {
      if (
        options[key as keyof GridStackNode] === undefined
      ) {
        delete options[key as keyof GridStackNode];
      }
    });

    return options;
  });

  onMount(() => {
    const element = elementRef();
    if (!element) return;
    const savedLayout = layout[element.id];
    if (savedLayout) {
      delete layout[element.id];
    }

    const widget = ctx.grid.makeWidget(element);

    createEffect(() => {
      const options = gridItemOptions();
      ctx.grid.update(element, options);
    });

    onCleanup(() => {
      const node = widget.gridstackNode;
      if (node) {
        layout[element.id] = {
          x: node.x,
          y: node.y,
          w: node.w,
          h: node.h,
        };
      }
      ctx.grid.removeWidget(widget, false, false);
    });
  });

  return (
    <Dynamic
      component={local.as ?? "div"}
      class={clsx(
        local.class,
        "grid-stack-item",
        local.noRemovable && "grid-stack-non-removable",
      )}
      ref={(ref) => setElementRef(ref)}
      gs-x={local.x}
      gs-y={local.y}
      gs-w={local.w}
      gs-h={local.h}
      gs-autoPosition={local.autoPosition}
      gs-minW={local.minW}
      gs-maxW={local.maxW}
      gs-minH={local.minH}
      gs-maxH={local.maxH}
      gs-locked={local.locked}
      gs-noResize={local.noResize}
      gs-noMove={local.noMove}
      {...other}
    >
      {local.children}
    </Dynamic>
  );
}

export const GridItemContent = (
  props: ComponentProps<"div">,
) => {
  const [local, other] = splitProps(props, [
    "children",
    "class",
  ]);
  return (
    <div
      class={clsx(
        local.class,
        "grid-stack-item-content touch-manipulation",
      )}
      {...other}
    >
      {local.children}
    </div>
  );
};

export type SavedGridItemProps = GridItemProps & {
  id: string;
};

export const SavedGridItem = (
  props: SavedGridItemProps,
) => {
  const savedLayout = layout[props.id];
  if (savedLayout) {
    delete layout[props.id];
  }
  const [local, other] = splitProps(props, [
    "x",
    "y",
    "w",
    "h",
  ]);
  return (
    <GridItem
      x={savedLayout?.x ?? local.x}
      y={savedLayout?.y ?? local.y}
      w={savedLayout?.w ?? local.w}
      h={savedLayout?.h ?? local.h}
      {...other}
    />
  );
};
