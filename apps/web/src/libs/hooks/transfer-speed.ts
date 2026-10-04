import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { createPresentationVisible } from "./presentation-visible";

type TransferSpeedOptions = {
  sampleInterval?: number;
  windowSize?: number;
  maxSpeed?: number;
};

/** Sample changed byte counters while visible, then decay a stalled transfer
 * to zero. Historical/resumed progress is never reported as a speed spike. */
const createTransferSpeed = (
  transferredSize: Accessor<number>,
  options: TransferSpeedOptions = {},
) => {
  const {
    sampleInterval = 250,
    windowSize = 10,
    maxSpeed = 256 * 1024 * 1024,
  } = options;
  const visible = createPresentationVisible();
  const [samples, setSamples] = createSignal<number[]>([]);
  let previous = transferredSize();
  let timestamp = performance.now();
  let ignoreNextPositiveDelta = true;
  let timer: number | undefined;

  const stop = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const reset = (current: number) => {
    stop();
    previous = current;
    timestamp = performance.now();
    ignoreNextPositiveDelta = true;
    setSamples([]);
  };
  const schedule = () => {
    timer = window.setTimeout(sample, sampleInterval);
  };
  const sample = () => {
    timer = undefined;
    if (!visible()) return;
    const current = transferredSize();
    const now = performance.now();
    const elapsed = (now - timestamp) / 1000;
    const delta = current - previous;
    const speed = elapsed > 0 ? delta / elapsed : 0;
    if (delta < 0 || speed > maxSpeed) {
      reset(current);
      return;
    }
    previous = current;
    timestamp = now;
    const next = [...samples(), speed].slice(-windowSize);
    setSamples(next);
    // After the averaging window becomes zero there is nothing left to repaint.
    if (next.some((value) => value > 0)) schedule();
  };

  createEffect(
    on(
      [transferredSize, visible],
      ([current, shown], before) => {
        if (!shown || !before?.[1] || current < previous) {
          reset(current);
          return;
        }
        if (current === previous) return;
        if (ignoreNextPositiveDelta) {
          previous = current;
          timestamp = performance.now();
          ignoreNextPositiveDelta = false;
          return;
        }
        if (timer === undefined) {
          timestamp = performance.now();
          schedule();
        }
      },
    ),
  );
  onCleanup(stop);
  return createMemo<number | null>(() => {
    const values = samples();
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) /
          values.length
      : null;
  });
};

export default createTransferSpeed;
