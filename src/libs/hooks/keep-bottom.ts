import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      keepBottom?: {};
    }
  }
}

export const keepBottom = (
  scrollElement: Document,
  enable: () => boolean,
) => {
  function toBottom(delay: number = 10, instant: boolean) {
    const scroll = () => {
      const element =
        scrollElement instanceof Document
          ? scrollElement.scrollingElement
          : scrollElement;

      element?.scrollTo({
        top: element.scrollHeight,
        behavior: instant ? "instant" : "smooth",
      });
    };

    window.setTimeout(scroll, delay);
  }

  let observer: MutationObserver = new MutationObserver(
    (mutationsList) => {
      if (enable()) {
        toBottom(0, true);
      }
    },
  );

  onMount(async () => {
    if (scrollElement instanceof Document) {
      const onResize = () => {
        if (enable()) {
          toBottom(10, true);
        }
      };

      window.addEventListener("resize", onResize);
      onCleanup(() => {
        window.removeEventListener("resize", onResize);
      });
    }

    if (scrollElement) {
      observer.observe(scrollElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      onCleanup(() => {
        observer?.disconnect();
      });
    }
  });
  return toBottom;
};

export const createScrollEnd = (
  scrollElement: Document,
) => {
  const [scroll, setScroll] = createSignal<{
    height: number;
    width: number;
    top: number;
    bottom: number;
    left: number;
    right: number;
  }>();
  onMount(() => {
    const onScroll = () => {
      const element =
        scrollElement instanceof Document
          ? scrollElement.scrollingElement ||
            document.documentElement
          : scrollElement;
      if (element) {
        // 使用 visualViewport 获取准确的视口高度
        const scrollTop =
          window.scrollY || element.scrollTop;
        const scrollLeft =
          window.scrollX || element.scrollLeft;
        const windowHeight = window.visualViewport
          ? window.visualViewport.height
          : window.innerHeight;
        const windowWidth = window.visualViewport
          ? window.visualViewport.width
          : window.innerWidth;
        const scrollHeight = element.scrollHeight;
        const scrollWidth = element.scrollWidth;

        setScroll({
          height: scrollHeight,
          width: scrollWidth,
          top: scrollTop,
          bottom: scrollTop + windowHeight,
          left: scrollLeft,
          right: scrollLeft + windowWidth,
        });
      }
    };
    onScroll();
    scrollElement.addEventListener("scroll", onScroll);
    // listen resize event, because address bar show/hide will trigger resize
    // window.addEventListener("resize", onScroll);
    onCleanup(() => {
      scrollElement.removeEventListener("scroll", onScroll);
      // window.removeEventListener("resize", onScroll);
    });
  });
  return scroll;
};
