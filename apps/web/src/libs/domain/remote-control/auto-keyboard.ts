import { controlId } from "../protocol/remote-control";

/** Field identity is opaque; no field text, labels or passwords cross the wire. */
export type TextInputFocus =
  | { type: "unknown" }
  | { type: "none" }
  | { type: "editable"; id: string };

export function parseTextInputFocus(
  value: unknown,
): TextInputFocus | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.type === "unknown" || v.type === "none")
    return { type: v.type };
  if (v.type === "editable" && controlId(v.id))
    return { type: "editable", id: v.id };
}

/** Local ownership and dismissal outlive transient input-epoch resets. */
export class AutoKeyboard {
  private owner: "automatic" | "manual" | undefined;
  private suppressed = false;
  private focus?: string;

  tap(): void {
    this.suppressed = false;
  }
  manual(): void {
    this.owner = "manual";
  }
  dismiss(): void {
    this.owner = undefined;
    this.suppressed = true;
  }

  receive(
    focus: TextInputFocus,
    allowOpen: boolean,
  ): "show" | "hide" | "reset" | undefined {
    if (focus.type === "unknown") return;
    const previous = this.focus;
    this.focus =
      focus.type === "editable" ? focus.id : undefined;
    if (focus.type === "none") {
      if (this.owner === "automatic") {
        this.owner = undefined;
        return "hide";
      }
      return;
    }
    if (this.owner === "automatic") {
      if (previous !== undefined && previous !== focus.id)
        return "reset";
    } else if (
      !this.owner &&
      !this.suppressed &&
      allowOpen
    ) {
      this.owner = "automatic";
      return "show";
    }
  }
}
