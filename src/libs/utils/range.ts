export type ChunkRange = number | [number, number];

// 合并连续索引的函数
export function mergeRanges(
  arr: number[],
): (number | [number, number])[] {
  if (arr.length === 0) return [];

  arr.sort((a, b) => a - b); // 确保数组是排序的
  const result: ChunkRange[] = [];

  let start = arr[0];
  let end = arr[0];

  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === end + 1) {
      // 如果是连续的索引，更新 end
      end = arr[i];
    } else {
      // 如果不是连续的，保存当前的范围
      if (start === end) {
        result.push(start);
      } else {
        result.push([start, end]);
      }
      start = arr[i];
      end = arr[i];
    }
  }

  // 保存最后的范围
  if (start === end) {
    result.push(start);
  } else {
    result.push([start, end]);
  }

  return result;
}

// 解析合并后的范围，返回原始数组的函数
export function parseRanges(
  ranges: ChunkRange[],
): number[] {
  const result: number[] = [];

  for (const range of ranges) {
    if (typeof range === "number") {
      result.push(range); // 如果是单个数字，直接加入结果数组
    } else {
      const [start, end] = range;
      for (let i = start; i <= end; i++) {
        result.push(i); // 将范围内的数字逐个加入结果数组
      }
    }
  }

  return result;
}

export function* rangeIterator(start: number, end: number) {
  for (let i = start; i <= end; i++) {
    yield i;
  }
}

export function* rangesIterator(ranges: ChunkRange[]) {
  for (const range of ranges) {
    if (typeof range === "number") {
      yield range;
    } else {
      const [start, end] = range;
      yield* rangeIterator(start, end);
    }
  }
}

export function getRangesLength(ranges: ChunkRange[]) {
  let length = 0;
  for (const range of ranges) {
    if (typeof range === "number") {
      length += 1;
    } else {
      const [start, end] = range;
      length += end - start + 1;
    }
  }
  return length;
}

export function getLastIndex(ranges: ChunkRange[]): number {
  if (ranges.length === 0) return -1;
  const lastRange = ranges[ranges.length - 1];
  if (typeof lastRange === "number") {
    return lastRange;
  } else {
    return lastRange[1];
  }
}

/**
 * 计算给定总长度范围内未被排除的子范围。
 *
 * 该函数接收一个范围总长度和需要排除的范围数组，然后返回剩余的子范围。
 * 它首先生成一个全范围的索引数组，然后根据需要排除的范围依次移除不需要的部分，最后将剩余部分合并成子范围。
 *
 * @param totalLength - 范围的总长度（即原始区块或索引的总数量）。
 * @param exclusionRanges - 要排除的范围数组，可以是单个索引或索引的范围（数组）。
 * @returns - 过滤后的子范围数组，表示剩余的未排除范围。
 */
export function getSubRanges(
  totalLength: number,
  exclusionRanges: ChunkRange[],
) {
  // 生成一个包含所有索引的数组，表示完整的范围
  const remainingChunks = Array.from({
    length: totalLength,
  }).map((_, index) => index);

  // 排序并倒序排除范围（需要从大到小移除，避免索引错位）
  const sortedExcludedIndices = Array.from(
    rangesIterator(exclusionRanges),
  ).sort((a, b) => b - a);

  // 从完整的范围中移除所有需要排除的索引
  for (const index of sortedExcludedIndices) {
    remainingChunks.splice(index, 1);
  }

  // 合并剩余的索引为连续的子范围
  const mergedChunks = mergeRanges(remainingChunks);
  return mergedChunks;
}

/**
 * 判断给定的 ranges 中是否包含指定的索引。
 *
 * @param ranges - 要检查的范围数组，数组中的元素可以是单个索引（number）或索引范围（number[]）。
 * @param targetIndex - 要检查的目标索引。
 * @returns - 如果目标索引在 ranges 中，则返回 true，否则返回 false。
 */
export function isIndexInRanges(
  ranges: ChunkRange[],
  targetIndex: number,
): boolean {
  for (const range of ranges) {
    if (typeof range === "number") {
      // 如果是单个数字，直接检查是否等于目标索引
      if (range === targetIndex) {
        return true;
      }
    } else {
      // 如果是范围数组，检查索引是否在该范围内
      const [start, end] = range;
      if (targetIndex >= start && targetIndex <= end) {
        return true;
      }
    }
  }
  return false;
}
