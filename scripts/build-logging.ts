import type { ESBuildOptions } from "vite";

/** Shared by the app, Web Workers and the separate PWA service-worker build. */
export function getBuildLoggingOptions(
  mode: string,
): ESBuildOptions {
  if (mode !== "production") return {};

  return {
    // Keep info/warn/error. Unlike drop: ["console"], pure calls also preserve
    // side effects in arguments, so removing a log cannot skip application work.
    pure: ["console.log", "console.debug", "console.trace"],
    drop: ["debugger"],
  };
}
