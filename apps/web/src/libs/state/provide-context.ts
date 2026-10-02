import {
  createComponent,
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
      return children();
    },
  });
}
