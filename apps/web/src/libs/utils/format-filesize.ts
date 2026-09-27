export function formatBtyeSize(
  bytes: number,
  decimals: number = 2,
) {
  if (bytes === 0) return (0).toFixed(decimals) + " B";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = [
    "B",
    "KB",
    "MB",
    "GB",
    "TB",
    "PB",
    "EB",
    "ZB",
    "YB",
  ];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  // directly use toFixed to keep the decimal point of 0
  return (
    (bytes / Math.pow(k, i)).toFixed(dm) + " " + sizes[i]
  );
}

export function formatBitSize(
  bit: number,
  decimals: number = 2,
) {
  if (bit === 0) return (0).toFixed(decimals) + " b";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = [
    "b",
    "Kb",
    "Mb",
    "Gb",
    "Tb",
    "Pb",
    "Eb",
    "Zb",
    "Yb",
  ];

  const i = Math.floor(Math.log(bit) / Math.log(k));

  // directly use toFixed to keep the decimal point of 0
  return (
    (bit / Math.pow(k, i)).toFixed(dm) + " " + sizes[i]
  );
}
