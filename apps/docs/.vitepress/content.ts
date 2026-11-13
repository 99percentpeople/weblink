export function sourceForPage(
  relativePath: string,
): string {
  return "docs/" + relativePath;
}

// This function is serialized into the browser search bundle. Keep it
// self-contained so indexing and searching use exactly the same tokenizer.
export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter("zh-CN", {
        granularity: "word",
      }).segment(normalized),
    )
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  }
  return (
    normalized.match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu) ??
    []
  );
}
