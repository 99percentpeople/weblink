import {
  Accessor,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

type TransferSpeedOptions = {
  sampleInterval?: number;
  windowSize?: number;
  maxSpeed?: number;
};

/**
 * Calculate the average transfer speed based on the received bytes
 * @param transferredSize - The size of the transferred bytes
 * @param options - The options for the transfer speed
 * @returns The average transfer speed
 */
const createTransferSpeed = (
  transferredSize: Accessor<number>,
  options: TransferSpeedOptions = {},
) => {
  const {
    sampleInterval = 250,
    windowSize = 10,
    maxSpeed = 256 * 1024 * 1024,
  } = options;
  const [prevTransferred, setPrevTransferred] =
    createSignal<number>(transferredSize());
  const [prevTimestamp, setPrevTimestamp] =
    createSignal<number>(performance.now());
  const [speedSamples, setSpeedSamples] = createSignal<
    number[]
  >([]);
  let ignoreNextPositiveDelta = true;
  let interval: number;
  const averageSpeed = createMemo<number | null>(() => {
    if (speedSamples().length > 0) {
      const avgSpeed =
        speedSamples().reduce(
          (acc, speed) => acc + speed,
          0,
        ) / speedSamples().length;
      return avgSpeed;
    } else {
      return null;
    }
  });

  const setSample = () => {
    const now = performance.now();
    const timeElapsed = (now - prevTimestamp()) / 1000;
    const currentTransferred = transferredSize();
    const transferredInLastInterval =
      currentTransferred - prevTransferred();
    if (timeElapsed > 0) {
      if (transferredInLastInterval < 0) {
        setSpeedSamples([]);
        setPrevTransferred(currentTransferred);
        setPrevTimestamp(now);
        ignoreNextPositiveDelta = true;
        return;
      }

      if (
        ignoreNextPositiveDelta &&
        transferredInLastInterval > 0
      ) {
        setSpeedSamples([]);
        setPrevTransferred(currentTransferred);
        setPrevTimestamp(now);
        ignoreNextPositiveDelta = false;
        return;
      }

      const currentSpeed =
        transferredInLastInterval / timeElapsed;
      if (currentSpeed > maxSpeed) {
        setSpeedSamples([]);
        setPrevTransferred(currentTransferred);
        setPrevTimestamp(now);
        ignoreNextPositiveDelta = true;
        return;
      }

      setSpeedSamples((prevSamples) => {
        const newSamples = [...prevSamples, currentSpeed];
        return newSamples.length > windowSize
          ? newSamples.slice(1)
          : newSamples;
      });
    }

    setPrevTransferred(currentTransferred);
    setPrevTimestamp(now);
  };

  onMount(() => {
    setSpeedSamples([]);
    setPrevTransferred(transferredSize());
    setPrevTimestamp(performance.now());
    ignoreNextPositiveDelta = true;
    interval = window.setInterval(
      setSample,
      sampleInterval,
    );
  });

  onCleanup(() => {
    window.clearInterval(interval);
  });

  return averageSpeed;
};

export default createTransferSpeed;
