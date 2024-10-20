import { cn } from "@/libs/cn";
import {
  ComponentProps,
  createSignal,
  JSX,
  ParentProps,
  splitProps,
} from "solid-js";

interface DropAreaProps
  extends ParentProps,
    Omit<
      ComponentProps<"div">,
      | "onDragEnter"
      | "onDragOver"
      | "onDragLeave"
      | "onDrop"
    > {
  onDragEnter?: (event: DragEvent) => JSX.Element;
  onDragOver?: (event: DragEvent) => JSX.Element;
  onDragLeave?: (event: DragEvent) => JSX.Element;
  onDrop?: (event: DragEvent) => void;
}

export default function DropArea(props: DropAreaProps) {
  const [local, other] = splitProps(props, [
    "class",
    "children",
    "onDragEnter",
    "onDragOver",
    "onDragLeave",
    "onDrop",
  ]);

  const [dragging, setDragging] = createSignal<
    "enter" | "over" | "leave" | null
  >(null);
  const [eventInfo, setEventInfo] =
    createSignal<DragEvent | null>(null);

  const handleDragEnter = (event: DragEvent) => {
    event.preventDefault();
    setDragging("enter");
    setEventInfo(event);
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    setDragging("over");
    setEventInfo(event);
  };

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    setDragging("leave");
    setEventInfo(event);
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    local.onDrop?.(event);
    setDragging(null);
  };

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      class={cn(local.class)}
      {...other}
    >
      {local.children}
      {dragging() === "enter" &&
        local.onDragEnter &&
        local.onDragEnter(eventInfo()!)}
      {dragging() === "over" &&
        local.onDragOver &&
        local.onDragOver(eventInfo()!)}
      {dragging() === "leave" &&
        local.onDragLeave &&
        local.onDragLeave(eventInfo()!)}
    </div>
  );
}
