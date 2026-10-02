// A removable character lets mobile keyboards emit repeated Backspace on an
// otherwise empty editor. It is never sent to the remote computer.
export const REMOTE_TEXT_SEED = "\u200b";

/** IME staging only. The DOM editor is the source of truth, not InputEvent.data. */
export class RemoteTextInput {
  private composing = false;
  private finishing?: ReturnType<typeof setTimeout>;
  get hasComposition(): boolean {
    return this.composing || this.finishing !== undefined;
  }
  constructor(
    private readonly port: {
      read(): string;
      reset(): void;
      commit(text: string): void;
      key(code: "Backspace" | "Delete" | "Enter"): void;
    },
  ) {}
  compositionStart(): void {
    this.finish();
    this.composing = true;
  }
  compositionEnd(): void {
    this.composing = false;
    clearTimeout(this.finishing);
    // Browsers may emit their final input before or after compositionend.
    // Keep the editor intact until that sequence finishes, and commit once.
    this.finishing = setTimeout(() => this.finish(), 0);
  }
  beforeInput(
    type: string,
    composing: boolean,
    cancelable: boolean,
  ): boolean {
    if (this.composing || composing) return false;
    // A final composition input belongs to the pending commit.
    if (
      type === "insertFromComposition" ||
      type === "insertCompositionText" ||
      (this.finishing !== undefined &&
        type.startsWith("insert"))
    )
      return false;
    this.finish();
    if (!cancelable) return false;
    const key = this.editKey(type);
    if (key) {
      this.port.key(key);
      this.port.reset();
      return true;
    }
    // This editor has no remote document model for undo, formatting or word ranges.
    return !type.startsWith("insert");
  }
  input(type: string, composing: boolean): void {
    if (
      this.composing ||
      composing ||
      this.finishing !== undefined
    )
      return;
    const key = this.editKey(type);
    if (key) this.port.key(key);
    else if (!type || type.startsWith("insert"))
      this.commitValue();
    this.port.reset();
  }
  paste(text: string): void {
    if (this.composing) return;
    this.finish();
    if (text) this.port.commit(text);
    this.port.reset();
  }
  private editKey(type: string) {
    if (type === "deleteContentBackward")
      return "Backspace";
    if (type === "deleteContentForward") return "Delete";
    if (
      type === "insertLineBreak" ||
      type === "insertParagraph"
    )
      return "Enter";
  }
  private commitValue(): void {
    const value = this.port.read();
    const text = value.startsWith(REMOTE_TEXT_SEED)
      ? value.slice(1)
      : value;
    if (text) this.port.commit(text);
  }
  private finish(): void {
    if (this.finishing === undefined) return;
    clearTimeout(this.finishing);
    this.finishing = undefined;
    this.commitValue();
    this.port.reset();
  }
  /** Blur, preference changes and connection loss discard uncommitted composition. */
  reset(): void {
    clearTimeout(this.finishing);
    this.finishing = undefined;
    this.composing = false;
    this.port.reset();
  }
}
