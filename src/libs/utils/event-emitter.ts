export type EventHandler<T = any> = (
  event: CustomEvent<T>,
) => any;

export interface EventListenerOptions {
  capture?: boolean;
}

export interface AddEventListenerOptions
  extends EventListenerOptions {
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

type ListenerEntry = {
  listener: EventListenerOrEventListenerObject;
  options: AddEventListenerOptions;
};

export class MultiEventEmitter<
  Events extends Record<string, any>,
> {
  private eventTarget: EventTarget;
  private listeners: Map<string, ListenerEntry[]>;
  private listenerMap: WeakMap<
    EventHandler<Events[keyof Events]>,
    EventListener
  >;

  constructor() {
    if (
      typeof EventTarget !== "undefined" &&
      typeof AbortController !== "undefined"
    ) {
      this.eventTarget = new EventTarget();
    } else {
      this.eventTarget = this.createCustomEventTarget();
    }
    this.listeners = new Map();
    this.listenerMap = new WeakMap();
  }

  addEventListener<K extends keyof Events>(
    type: K,
    listener: EventHandler<Events[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const opts = this.normalizeOptions(options);

    // 检查是否已存在包装后的监听器
    let wrappedListener = this.listenerMap.get(
      listener as EventHandler<Events[keyof Events]>,
    );
    if (!wrappedListener) {
      wrappedListener = (event: Event) => {
        listener(event as CustomEvent<Events[K]>);
      };
      this.listenerMap.set(
        listener as EventHandler<Events[keyof Events]>,
        wrappedListener,
      );
    }

    // 处理 signal
    if (opts.signal) {
      if (opts.signal.aborted) {
        return;
      }
      const abortHandler = () => {
        this.removeEventListener(type, listener, opts);
      };
      opts.signal.addEventListener("abort", abortHandler);
    }

    this.eventTarget.addEventListener(
      type as string,
      wrappedListener,
      opts,
    );

    // 如果是自定义实现，记录监听器以便移除
    if (!(this.eventTarget instanceof EventTarget)) {
      if (!this.listeners.has(type as string)) {
        this.listeners.set(type as string, []);
      }
      this.listeners
        .get(type as string)!
        .push({ listener: wrappedListener, options: opts });
    }
  }

  removeEventListener<K extends keyof Events>(
    type: K,
    listener: EventHandler<Events[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    const opts = this.normalizeOptions(options);

    // 获取已存储的包装监听器
    const wrappedListener = this.listenerMap.get(
      listener as EventHandler<Events[keyof Events]>,
    );
    if (!wrappedListener) {
      // 如果没有找到对应的包装监听器，说明从未添加过，直接返回
      return;
    }

    this.eventTarget.removeEventListener(
      type as string,
      wrappedListener,
      opts,
    );

    // 从自定义监听器列表中移除
    if (
      !(this.eventTarget instanceof EventTarget) &&
      this.listeners.has(type as string)
    ) {
      const listeners = this.listeners.get(type as string)!;
      for (let i = 0; i < listeners.length; i++) {
        if (
          listeners[i].listener === wrappedListener &&
          this.compareOptions(listeners[i].options, opts)
        ) {
          listeners.splice(i, 1);
          break;
        }
      }
    }

    // 从映射中删除监听器
    this.listenerMap.delete(
      listener as EventHandler<Events[keyof Events]>,
    );
  }

  dispatchEvent<K extends keyof Events>(
    type: K,
    detail: Events[K],
  ): boolean {
    const event = new CustomEvent<Events[K]>(
      type as string,
      { detail },
    );
    return this.eventTarget.dispatchEvent(event);
  }

  // 辅助方法
  private normalizeOptions(
    options?: boolean | AddEventListenerOptions,
  ): AddEventListenerOptions {
    if (typeof options === "boolean") {
      return { capture: options };
    } else if (options === undefined) {
      return {};
    } else {
      return options;
    }
  }

  private compareOptions(
    opts1: AddEventListenerOptions,
    opts2: AddEventListenerOptions,
  ): boolean {
    return (
      opts1.capture === opts2.capture &&
      opts1.once === opts2.once &&
      opts1.passive === opts2.passive
    );
  }

  private createCustomEventTarget(): EventTarget {
    const listeners = this.listeners;
    const normalizeOptions =
      this.normalizeOptions.bind(this);
    const compareOptions = this.compareOptions.bind(this);

    const removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      const opts = normalizeOptions(options);
      if (!listeners.has(type)) return;
      const typeListeners = listeners.get(type)!;
      for (let i = 0; i < typeListeners.length; i++) {
        if (
          typeListeners[i].listener === listener &&
          compareOptions(typeListeners[i].options, opts)
        ) {
          typeListeners.splice(i, 1);
          break;
        }
      }
    };

    return {
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        const opts = normalizeOptions(options);
        if (!listeners.has(type)) {
          listeners.set(type, []);
        }
        listeners
          .get(type)!
          .push({ listener, options: opts });
      },

      removeEventListener,

      dispatchEvent: (event: Event): boolean => {
        if (!listeners.has(event.type)) return true;
        const typeListeners = listeners.get(event.type)!;

        for (const {
          listener,
          options,
        } of typeListeners.slice()) {
          try {
            if (typeof listener === "function") {
              listener.call(null, event);
            } else if (
              listener &&
              typeof listener.handleEvent === "function"
            ) {
              listener.handleEvent(event);
            }
          } catch (err) {
            console.error(err);
          }
          if (options.once) {
            removeEventListener(
              event.type,
              listener,
              options,
            );
          }
        }
        return !event.defaultPrevented;
      },
    } as EventTarget;
  }
}
