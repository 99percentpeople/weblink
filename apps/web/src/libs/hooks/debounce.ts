import {
  createSignal,
  onCleanup,
  createEffect,
} from "solid-js";

interface Options {
  leading?: boolean;
  trailing?: boolean;
  maxWait?: number;
}

export const createDebounce = <T>(
  value: () => T,
  delay: number = 300,
  options: Options = { leading: false, trailing: true },
) => {
  const [debouncedValue, setDebouncedValue] =
    createSignal<T>(value());
  let timeoutId: NodeJS.Timeout | null = null;
  let lastCallTime = 0;

  createEffect(() => {
    const currentValue = value();
    const now = Date.now();

    if (options.leading && !timeoutId) {
      setDebouncedValue(() => currentValue);
    }

    if (options.maxWait) {
      if (now - lastCallTime >= options.maxWait) {
        setDebouncedValue(() => currentValue);
        lastCallTime = now;
        return;
      }
    }

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      if (options.trailing) {
        setDebouncedValue(() => currentValue);
      }
      timeoutId = null;
    }, delay);

    lastCallTime = now;

    onCleanup(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  });

  return debouncedValue;
};

export const createDebounceAsync = <T extends any[], R>(
  asyncFn: (...args: T) => Promise<R>,
  delay: number = 300,
) => {
  const [result, setResult] = createSignal<R | null>(null);
  const [error, setError] = createSignal<Error | null>(
    null,
  );
  const [isPending, setIsPending] = createSignal(false);

  let timeoutId: NodeJS.Timeout | null = null;
  let abortController: AbortController | null = null;

  const execute = (...args: T) => {
    if (abortController) {
      abortController.abort();
    }

    abortController = new AbortController();
    setIsPending(true);

    asyncFn(...args)
      .then((data) => {
        if (!abortController?.signal.aborted) {
          setResult(() => data);
          setError(null);
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setError(err);
        }
      })
      .finally(() => {
        if (!abortController?.signal.aborted) {
          setIsPending(false);
        }
      });
  };

  const debouncedFn = (...args: T) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => execute(...args), delay);
  };

  onCleanup(() => {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortController) abortController.abort();
  });

  return {
    debouncedFn,
    result,
    error,
    isPending,
    cancel: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (abortController) abortController.abort();
    },
  };
};
