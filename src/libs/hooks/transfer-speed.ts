import {
  Accessor,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

type TransferSpeedOptions = {
  sampleInterval?: number; // 采样间隔
  windowSize?: number; // 滑动窗口大小
};

// 根据收到的字节数计算平均传输速度
const createTransferSpeed = (
  transferredSize: Accessor<number>,
  options: TransferSpeedOptions = {},
) => {
  const { sampleInterval = 500, windowSize = 10 } = options; // 设置默认值
  const [prevTransferred, setPrevTransferred] =
    createSignal<number>(transferredSize()); // 上一次的传输大小
  const [prevTimestamp, setPrevTimestamp] =
    createSignal<number>(performance.now());
  const [speedSamples, setSpeedSamples] = createSignal<
    number[]
  >([]); // 速度样本窗口
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
  }); // 平滑后的平均速度

  const setSample = () => {
    const now = performance.now(); // 获取当前高精度时间戳
    const timeElapsed = (now - prevTimestamp()) / 1000; // 计算时间差（秒）
    const transferredInLastInterval =
      transferredSize() - prevTransferred();
    if (timeElapsed > 0 && transferredInLastInterval >= 0) {
      const currentSpeed =
        transferredInLastInterval / timeElapsed; // 当前传输速度（字节/秒）
      // 更新速度样本数组，并保持最多为 windowSize 个样本
      setSpeedSamples((prevSamples) => {
        const newSamples = [...prevSamples, currentSpeed];
        return newSamples.length > windowSize
          ? newSamples.slice(1)
          : newSamples;
      });
    }

    setPrevTransferred(transferredSize);
    setPrevTimestamp(now);
  };

  onMount(() => {
    setSample();
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
