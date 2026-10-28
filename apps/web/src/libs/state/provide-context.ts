import {
  createComponent,
  untrack,
  type Context,
  type JSX,
} from "solid-js";

/** Creates a native provider scope without putting its lifetime in a UI component. */
export function provideContext<T>(
  context: Context<T>,
  value: T,
  children: () => JSX.Element,
): JSX.Element {
  return createComponent(context.Provider, {
    value,
    get children() {
      // Service initialization may read reactive state (e.g. local capture).
      // Keep those reads out of the provider's child memo so updates do not
      // dispose the entire application subtree and its active control owners.
      return untrack(children);
    },
  });
}
