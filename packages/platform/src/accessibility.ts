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
}
export interface AccessibilityCapabilities {
  supported: boolean;
  backend: string | null;
  actions: AccessibilityAction[];
  maxNodes?: number;
  maxDepth?: number;
  referenceTtlMs?: number;
  coordinateSpace?: "desktopPhysicalPixels";
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
} & (
  | { action: "setValue"; value: string }
  | {
      action: Exclude<AccessibilityAction, "setValue">;
      value?: never;
    }
);
export interface AccessibilityActionResult {
  applied: true;
  refreshRequired: true;
}
