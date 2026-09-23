import {
  clearDelegatedEvents,
  delegateEvents,
  DelegatedEvents,
} from "solid-js/web";

/** Styles and delegated handlers belong to each Document independently. */
export function preparePictureInPictureDocument(
  source: Document,
  target: Document,
) {
  const base = target.createElement("base");
  base.href = source.baseURI;
  target.head.append(base);
  let sheets: Element[] = [];
  const syncStyles = () => {
    const next = [
      ...source.querySelectorAll(
        'style, link[rel="stylesheet"]',
      ),
    ].map((sheet) => sheet.cloneNode(true) as Element);
    target.head.append(...next);
    sheets.forEach((sheet) => sheet.remove());
    sheets = next;
  };
  const syncTheme = () => {
    for (const name of [
      "class",
      "style",
      "lang",
      "dir",
      "data-kb-theme",
    ]) {
      const value =
        source.documentElement.getAttribute(name);
      if (value === null)
        target.documentElement.removeAttribute(name);
      else target.documentElement.setAttribute(name, value);
    }
  };
  syncStyles();
  syncTheme();
  const styles = new MutationObserver(syncStyles);
  styles.observe(source.head, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "media", "disabled"],
  });
  const theme = new MutationObserver(syncTheme);
  theme.observe(source.documentElement, {
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "lang",
      "dir",
      "data-kb-theme",
    ],
  });
  delegateEvents([...DelegatedEvents], target);
  return () => {
    styles.disconnect();
    theme.disconnect();
    clearDelegatedEvents(target);
    sheets.forEach((sheet) => sheet.remove());
    base.remove();
  };
}
