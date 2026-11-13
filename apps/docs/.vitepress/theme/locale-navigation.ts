// The default language menu carries the current hash into the other locale.
// Translated headings can differ, so drop that inherited fragment when
// switching between the English root and the same article under /zh/.
export function localeNavigationTarget(
  target: string,
  current: string,
  base: string,
): string {
  const from = new URL(current);
  const to = new URL(target, from);
  if (
    from.origin !== to.origin ||
    !to.hash ||
    to.hash !== from.hash ||
    !from.pathname.startsWith(base) ||
    !to.pathname.startsWith(base)
  )
    return target;

  const fromPath = from.pathname.slice(base.length);
  const toPath = to.pathname.slice(base.length);
  const fromChinese = fromPath.startsWith("zh/");
  const toChinese = toPath.startsWith("zh/");
  const fromArticle = fromChinese
    ? fromPath.slice(3)
    : fromPath;
  const toArticle = toChinese ? toPath.slice(3) : toPath;

  if (
    fromChinese !== toChinese &&
    fromArticle === toArticle
  ) {
    to.hash = "";
    return to.href;
  }
  return target;
}
