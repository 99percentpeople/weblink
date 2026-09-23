// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLayoutTransition,
  createLayoutValue,
} from "@/libs/hooks/layout-transition";

afterEach(cleanup);

describe("shared layout state", () => {
  it("commits the rendered value before measuring a shared state change", async () => {
    const [collapsed, setCollapsed] = createSignal(false);
    const measured: string[] = [];
    render(() => {
      let output!: HTMLOutputElement;
      const transition = createLayoutTransition(
        () => output,
        undefined,
        () => measured.push(output.textContent!),
      );
      const displayed = createLayoutValue(
        collapsed,
        transition,
      );
      return (
        <output ref={output}>
          {displayed() ? "collapsed" : "expanded"}
        </output>
      );
    });
    setCollapsed(true);
    await Promise.resolve();
    setCollapsed(false);
    await Promise.resolve();
    expect(measured).toEqual(["collapsed", "expanded"]);
  });

  it("coalesces pending changes and ignores them after disposal", async () => {
    const [value, setValue] = createSignal("initial");
    const measured: string[] = [];
    const view = render(() => {
      let output!: HTMLOutputElement;
      const transition = createLayoutTransition(
        () => output,
        undefined,
        () => measured.push(output.textContent!),
      );
      const displayed = createLayoutValue(
        value,
        transition,
      );
      return <output ref={output}>{displayed()}</output>;
    });
    setValue("discarded");
    setValue("latest");
    await Promise.resolve();
    expect(measured).toEqual(["latest"]);
    setValue("unmounted");
    view.unmount();
    await Promise.resolve();
    expect(measured).toEqual(["latest"]);
  });
});
