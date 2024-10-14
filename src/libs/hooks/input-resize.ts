import {
  Accessor,
  createEffect,
  onCleanup,
  onMount,
} from "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      textareaAutoResize?: {};
      inputAutoResize?: {};
    }
  }
}

export const textareaAutoResize = (
  el: HTMLElement,
  signal?: Accessor<string>,
) => {
  const resizeTextarea = () => {
    el.style.height = "";
    const borderHeight = el.offsetHeight - el.clientHeight;
    el.style.height = el.scrollHeight + borderHeight + "px";
  };

  createEffect(() => {
    signal?.();
    resizeTextarea();
  });

  onMount(() => {
    el.addEventListener("input", resizeTextarea);
    el.addEventListener("change", resizeTextarea);
    el.addEventListener("focus", resizeTextarea);
  });

  onCleanup(() => {
    el.removeEventListener("input", resizeTextarea);
    el.removeEventListener("change", resizeTextarea);
    el.removeEventListener("focus", resizeTextarea);
  });
};

export const inputAutoResize = (el: HTMLElement) => {
  const resizeInput = () => {
    el.style.width = "";
    const borderWidth = el.offsetWidth - el.clientWidth;
    el.style.width = el.scrollWidth + borderWidth + "px";
  };

  onMount(() => {
    el.addEventListener("input", resizeInput);
    el.addEventListener("change", resizeInput);
    el.addEventListener("focus", resizeInput);
    createEffect(() => setTimeout(() => resizeInput(), 10));
  });

  onCleanup(() => {
    el.removeEventListener("input", resizeInput);
    el.removeEventListener("change", resizeInput);
    el.removeEventListener("focus", resizeInput);
  });
};
