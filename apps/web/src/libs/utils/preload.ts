import { lazy, type Component } from "solid-js";

type LazyModule<T extends Component<any>> = { default: T };

/** Solid lazy with shared loading, explicit preloading and retryable warmups. */
export function preload<T extends Component<any>>(
  loader: () => Promise<LazyModule<T>>,
): T & { preload(): Promise<LazyModule<T>> } {
  let modulePromise: Promise<LazyModule<T>> | undefined;
  let preloadPromise: Promise<LazyModule<T>> | undefined;
  const load = () =>
    (modulePromise ??= Promise.resolve()
      .then(loader)
      .catch((error) => {
        modulePromise = undefined;
        throw error;
      }));
  const component = lazy(load);
  const prime = component.preload;

  component.preload = () =>
    (preloadPromise ??= load()
      .then(async (module) => {
        // Use Solid's public API only after loading succeeds. A failed
        // speculative import must not enter lazy's permanent promise cache.
        await prime();
        return module;
      })
      .catch((error) => {
        preloadPromise = undefined;
        throw error;
      }));

  return component;
}
