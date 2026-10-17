/** Directory-library visibility only. Hidden bytes remain accessible by path. */
export function isHiddenDirectoryEntry(
  name: string,
): boolean {
  // Chromium writes into sibling .crswap / .N.crswap transaction files until
  // createWritable().close(). Never treat those growing bytes as complete files.
  return (
    name.startsWith(".") ||
    name.toLowerCase().endsWith(".crswap")
  );
}
