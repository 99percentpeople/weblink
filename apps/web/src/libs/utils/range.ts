export type ChunkRange = number | [number, number];

// merge continuous indexes
export function mergeRanges(
  arr: number[],
): (number | [number, number])[] {
  if (arr.length === 0) return [];

  arr.sort((a, b) => a - b); // ensure the array is sorted
  const result: ChunkRange[] = [];

  let start = arr[0];
  let end = arr[0];

  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === end + 1) {
      // if the indexes are continuous, update end
      end = arr[i];
    } else {
      // if the indexes are not continuous, save the current range
      if (start === end) {
        result.push(start);
      } else {
        result.push([start, end]);
      }
      start = arr[i];
      end = arr[i];
    }
  }

  // save the last range
  if (start === end) {
    result.push(start);
  } else {
    result.push([start, end]);
  }

  return result;
}

// parse the merged ranges, return the original array
export function parseRanges(
  ranges: ChunkRange[],
): number[] {
  const result: number[] = [];

  for (const range of ranges) {
    if (typeof range === "number") {
      result.push(range); // if it's a single number, directly add to the result array
    } else {
      const [start, end] = range;
      for (let i = start; i <= end; i++) {
        result.push(i); // add the numbers in the range to the result array
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
 * Calculate the subranges that are not excluded in the given total length.
 *
 * This function takes the total length and the exclusion ranges, then returns the remaining subranges.
 * It first generates an array of all indexes, then removes the parts that need to be excluded one by one,
 * and finally merges the remaining parts into subranges.
 *
 * @param totalLength - The total length of the range (i.e., the total number of original chunks or indexes).
 * @param exclusionRanges - The exclusion ranges array, which can be a single index or an index range (array).
 * @returns - The remaining subranges after excluding the specified parts.
 */
export function getSubRanges(
  totalLength: number,
  exclusionRanges: ChunkRange[],
) {
  // generate an array of all indexes, representing the complete range
  const remainingChunks = Array.from({
    length: totalLength,
  }).map((_, index) => index);

  // sort and reverse the exclusion ranges (need to remove from large to small to avoid index misalignment)
  const sortedExcludedIndices = Array.from(
    rangesIterator(exclusionRanges),
  ).sort((a, b) => b - a);

  // remove all the indexes that need to be excluded from the complete range
  for (const index of sortedExcludedIndices) {
    remainingChunks.splice(index, 1);
  }

  // merge the remaining indexes into continuous subranges
  const mergedChunks = mergeRanges(remainingChunks);
  return mergedChunks;
}

/**
 * Determine if the given ranges contain the specified index.
 *
 * @param ranges - The ranges array to check, the elements can be a single index (number) or an index range (number[]).
 * @param targetIndex - The target index to check.
 * @returns - If the target index is in the ranges, return true, otherwise return false.
 */
export function isIndexInRanges(
  ranges: ChunkRange[],
  targetIndex: number,
): boolean {
  for (const range of ranges) {
    if (typeof range === "number") {
      // if it's a single number, directly check if it equals the target index
      if (range === targetIndex) {
        return true;
      }
    } else {
      // if it's a range array, check if the index is in the range
      const [start, end] = range;
      if (targetIndex >= start && targetIndex <= end) {
        return true;
      }
    }
  }
  return false;
}
