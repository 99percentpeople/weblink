interface SyncScrollElement extends HTMLElement {
  eX?: number;
  eY?: number;
  syn?: (this: HTMLElement, ev: Event) => any;
  scroller?: HTMLElement;
}

const names: { [key: string]: SyncScrollElement[] } = {};

function reset(): void {
  const elems = document.querySelectorAll(
    "[data-sync-scroll]",
  );

  // Clearing existing listeners
  for (const name in names) {
    if (Object.prototype.hasOwnProperty.call(names, name)) {
      for (let i = 0; i < names[name].length; i++) {
        names[name][i].removeEventListener(
          "scroll",
          names[name][i].syn!,
          false,
        );
      }
    }
  }

  // Setting up the new listeners
  for (let i = 0; i < elems.length; ) {
    let found = false;
    let j = 0;
    let el = elems[i++] as SyncScrollElement;
    const name = el.dataset.syncScroll;

    if (!name) {
      // 'name' attribute is not set
      continue;
    }

    el = (el.scroller || el) as SyncScrollElement;

    // Searching for existing entry in array of names
    names[name] = names[name] || [];
    while (j < names[name].length) {
      found = found || names[name][j] === el;
      j++;
    }

    if (!found) {
      names[name].push(el);
    }

    el.eX = el.eY = 0;

    ((el: SyncScrollElement, name: string) => {
      el.addEventListener(
        "scroll",
        (el.syn = function () {
          const elems = names[name];

          const scrollX = el.scrollLeft;
          const scrollY = el.scrollTop;

          const xRate =
            scrollX / (el.scrollWidth - el.clientWidth);
          const yRate =
            scrollY / (el.scrollHeight - el.clientHeight);

          const updateX = scrollX !== el.eX;
          const updateY = scrollY !== el.eY;

          el.eX = scrollX;
          el.eY = scrollY;

          for (let i = 0; i < elems.length; ) {
            const otherEl = elems[i++];
            if (otherEl !== el) {
              if (updateX) {
                const newScrollX = Math.round(
                  xRate *
                    (otherEl.scrollWidth -
                      otherEl.clientWidth),
                );
                if (
                  Math.round(otherEl.scrollLeft) !==
                  newScrollX
                ) {
                  otherEl.scrollLeft = newScrollX;
                  otherEl.eX = newScrollX;
                }
              }
              if (updateY) {
                const newScrollY = Math.round(
                  yRate *
                    (otherEl.scrollHeight -
                      otherEl.clientHeight),
                );
                if (
                  Math.round(otherEl.scrollTop) !==
                  newScrollY
                ) {
                  otherEl.scrollTop = newScrollY;
                  otherEl.eY = newScrollY;
                }
              }
            }
          }
        }),
        false,
      );
    })(el, name);
  }
}

if (document.readyState === "complete") {
  reset();
} else {
  window.addEventListener("load", reset, false);
}

export { reset };
