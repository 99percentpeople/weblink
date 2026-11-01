import { afterEach, expect, it } from "vitest";
import { createPresentationLayout } from "../src/presentation-layout";
import type { PresentationGeometry } from "../src/presentation-geometry";

afterEach(() => document.body.replaceChildren());

it("keeps shared mask resources alive until the last view detaches and recreates them on rebind", () => {
  const layout = createPresentationLayout();
  const first = document.createElement("video");
  const second = document.createElement("video");
  document.body.append(first, second);
  const firstKey = Symbol(),
    secondKey = Symbol();
  const rect = { x: 0, y: 0, width: 640, height: 360 };
  const geometry: PresentationGeometry = {
    rect,
    surface: rect,
    image: rect,
    local: { width: 640, height: 360 },
    clips: [
      {
        ...rect,
        corners: [
          [6, 6],
          [6, 6],
          [6, 6],
          [6, 6],
        ],
      },
    ],
    visible: true,
    opacity: 1,
  };
  layout.show(firstKey, first, geometry);
  layout.show(secondKey, second, geometry);
  const mask = document.querySelector("mask")!;
  const resources = [...mask.querySelectorAll("clipPath")];
  // Position/fade updates reuse the live resources rather than replacing them.
  layout.show(secondKey, second, {
    ...geometry,
    rect: { ...rect, x: 20 },
    surface: { ...rect, x: 20 },
    opacity: 0.5,
  });
  expect([...mask.querySelectorAll("clipPath")]).toEqual(
    resources,
  );
  layout.hide(firstKey, first);
  expect(mask.isConnected).toBe(true);
  layout.hide(firstKey, first);
  layout.hide(secondKey, second);
  expect(mask.isConnected).toBe(false);
  expect(document.querySelector("svg")).toBeNull();
  expect(first.getAttribute("style") || "").toBe("");
  expect(second.getAttribute("style") || "").toBe("");
  layout.show(firstKey, first, geometry);
  expect(document.querySelector("mask")).not.toBe(mask);
  layout.hide(firstKey, first);
  expect(document.body.children).toHaveLength(2);
});
