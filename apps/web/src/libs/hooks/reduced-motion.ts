import { createSignal, onCleanup } from "solid-js";

export function createReducedMotion() {
  const query = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  );
  const [reduced, setReduced] = createSignal(
    query?.matches ?? true,
  );
  const update = () => setReduced(query?.matches ?? true);
  query?.addEventListener("change", update);
  onCleanup(() =>
    query?.removeEventListener("change", update),
  );
  return reduced;
}
