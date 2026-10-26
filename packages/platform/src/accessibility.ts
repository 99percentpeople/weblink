/** OS-neutral desktop accessibility results. Native element pointers never cross this boundary. */
export type AccessibilityAction =
  | "focus"
  | "invoke"
  | "setValue"
  | "toggle"
  | "select"
  | "expand"
  | "collapse"
  | "scrollIntoView";

export type AccessibilityRole =
  | "window"
  | "button"
  | "checkBox"
  | "radioButton"
  | "textField"
  | "text"
  | "link"
  | "image"
  | "comboBox"
  | "list"
  | "listItem"
  | "tree"
  | "treeItem"
  | "tab"
  | "tabItem"
  | "menu"
  | "menuItem"
  | "menuBar"
  | "toolBar"
  | "slider"
  | "progressBar"
  | "scrollBar"
  | "table"
  | "row"
  | "header"
  | "headerItem"
  | "document"
  | "group"
  | "pane"
  | "separator"
  | "statusBar"
  | "spinner"
  | "unknown";

export interface AccessibilityNode {
  /** Caller-bound opaque reference; expires after 60 s, read-grant revocation or an action. */
  elementId: string;
  parentId: string | null;
  depth: number;
  role: AccessibilityRole;
  name: string;
  /** True means name is only a prefix and cannot satisfy exact-name wait conditions. */
  nameTruncated?: boolean;
  automationId: string;
  processId: number;
  /** Physical desktop pixels, potentially negative on secondary monitors. */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  enabled: boolean;
  focused: boolean;
  offscreen: boolean;
  protected: boolean;
  actions: AccessibilityAction[];
  toggleState?: "on" | "off" | "indeterminate";
  selected?: boolean;
  expandCollapseState?:
    | "collapsed"
    | "expanded"
    | "partiallyExpanded"
    | "leafNode";
  readOnly?: boolean;
  /** Opt-in bounded content; never present for protected controls. */
  value?: string;
  text?: string;
  valueTruncated?: boolean;
  textTruncated?: boolean;
}
export interface AccessibilityCapabilities {
  supported: boolean;
  backend: string | null;
  actions: AccessibilityAction[];
  maxNodes?: number;
  maxDepth?: number;
  referenceTtlMs?: number;
  coordinateSpace?: "desktopPhysicalPixels";
  maxTextLength?: number;
  supportsWait?: boolean;
  supportsObservation?: boolean;
}
export interface AccessibilityWindows {
  coordinateSpace: "desktopPhysicalPixels";
  windows: AccessibilityNode[];
  truncated: boolean;
  referenceTtlMs: number;
}
export interface AccessibilitySnapshot {
  coordinateSpace: "desktopPhysicalPixels";
  nodes: AccessibilityNode[];
  truncated: boolean;
  referenceTtlMs: number;
}
export type AccessibilityActionRequest = {
  elementId: string;
  observeAfter?: AccessibilityObservationOptions;
} & (
  | { action: "setValue"; value: string }
  | {
      action: Exclude<AccessibilityAction, "setValue">;
      value?: never;
    }
);
export interface AccessibilityActionResult {
  applied: true;
  /** Previous references always expire. False means observation supplies fresh references. */
  refreshRequired: boolean;
  observation?: AccessibilitySnapshot;
  observationError?: { code: string; message: string };
}

export interface AccessibilityReadOptions {
  includeValues?: boolean;
  /** Unicode characters per value/text field; default 1024, maximum 4096. */
  maxTextLength?: number;
}
export interface AccessibilityObservationOptions extends AccessibilityReadOptions {
  /** Omit to observe the same native element as the action; resolved before acting. */
  elementId?: string;
  maxDepth?: number;
  maxNodes?: number;
}
export interface AccessibilityWaitCondition {
  enabled?: boolean;
  focused?: boolean;
  offscreen?: boolean;
  selected?: boolean;
  toggleState?: AccessibilityNode["toggleState"];
  expandCollapseState?: AccessibilityNode["expandCollapseState"];
  value?: string;
  /** Searches at most the first 4096 Unicode characters. */
  textContains?: string;
  name?: string;
}
/** Read once, then re-read the same element only when a UIA event arrives. */
export interface AccessibilityWaitRequest {
  elementId: string;
  condition: AccessibilityWaitCondition;
  /** Overall deadline in milliseconds; default 5000, range 1–30000. No polling. */
  timeoutMs?: number;
}
export interface AccessibilityWaitResult {
  matched: boolean;
  /** No match was observed by the deadline; no final scan is performed. */
  timedOut: boolean;
  elapsedMs: number;
  /** Fresh reference when matched; null on timeout, never a cached unvalidated node. */
  node: AccessibilityNode | null;
}
