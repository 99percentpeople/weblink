/** Content identity is independent of names, transfer IDs and chunk boundaries. */
export interface FileFingerprint {
  version: 1;
  algorithm: "blake3-256";
  digest: string;
  size: number;
}

export function isFileFingerprint(
  value: unknown,
): value is FileFingerprint {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 1 &&
    item.algorithm === "blake3-256" &&
    typeof item.digest === "string" &&
    /^[a-f0-9]{64}$/.test(item.digest) &&
    Number.isSafeInteger(item.size) &&
    (item.size as number) >= 0 &&
    Object.keys(item).every((key) =>
      ["version", "algorithm", "digest", "size"].includes(
        key,
      ),
    )
  );
}

export function contentKey(
  fingerprint: FileFingerprint,
): string {
  if (!isFileFingerprint(fingerprint))
    throw new Error("Invalid file fingerprint");
  return `v1:blake3-256:${fingerprint.size}:${fingerprint.digest}`;
}
