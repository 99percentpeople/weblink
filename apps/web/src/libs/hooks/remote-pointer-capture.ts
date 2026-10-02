import {
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

/** Own a browser pointer lock, including requests that finish after release/unmount. */
export function createRemotePointerCapture(options: {
  element: Accessor<HTMLElement | undefined>;
  enabled: Accessor<boolean>;
  released(): void;
  failed(): void;
}) {
  const [active, setActive] = createSignal(false);
  let request = () => {};
  let release = () => {};
  createEffect(() => {
    const element = options.element();
    if (!element) return;
    const doc = element.ownerDocument;
    const life = new AbortController();
    let disposed = false;
    let wanted = false;
    let locked = false;
    let pending = false;
    let sequence = 0;
    const stop = () => {
      wanted = false;
      if (locked) {
        locked = false;
        setActive(false);
        options.released();
      }
      if (doc.pointerLockElement === element)
        doc.exitPointerLock();
    };
    const settled = () => {
      pending = false;
      if (disposed) life.abort();
    };
    const failed = () => {
      if (!pending) return;
      const notify = pending && wanted && !disposed;
      settled();
      stop();
      if (notify) options.failed();
    };
    doc.addEventListener(
      "pointerlockchange",
      () => {
        if (doc.pointerLockElement === element) {
          if (
            disposed ||
            !wanted ||
            !options.enabled() ||
            doc.hidden
          ) {
            stop();
          } else if (!locked) {
            locked = true;
            element.focus({ preventScroll: true });
            setActive(true);
          }
          settled();
        } else if (locked) {
          stop();
        }
      },
      { signal: life.signal },
    );
    doc.addEventListener("pointerlockerror", failed, {
      signal: life.signal,
    });
    release = stop;
    request = () => {
      if (
        disposed ||
        pending ||
        locked ||
        !options.enabled() ||
        doc.hidden
      )
        return;
      // Never take a lock owned by another surface/window.
      if (
        doc.pointerLockElement ||
        !element.requestPointerLock
      ) {
        options.failed();
        return;
      }
      pending = wanted = true;
      const id = ++sequence;
      try {
        // Older WebViews return void; pointerlockchange/error still settle them.
        void Promise.resolve(
          element.requestPointerLock(),
        ).catch(() => {
          if (id === sequence && pending) failed();
        });
      } catch {
        failed();
      }
    };
    onCleanup(() => {
      disposed = true;
      stop();
      // Keep only the terminal listeners until an in-flight request settles,
      // so a late grant cannot hide the cursor after the surface disappears.
      if (!pending) life.abort();
      request = release = () => {};
    });
  });
  createEffect(() => {
    if (!options.enabled()) release();
  });
  return {
    active,
    request: () => request(),
    release: () => release(),
  };
}
