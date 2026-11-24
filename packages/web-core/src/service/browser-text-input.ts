/** Owns the local IME session for the remote text sink. Only committed text
 * crosses the link, and a composition can only finish in its starting view. */
export class BrowserTextInput {
  private composing: { viewVersion: number | undefined } | undefined;
  private tail: { text: string; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(private readonly commit: (text: string, viewVersion: number) => void) {}

  get active(): boolean {
    return this.composing !== undefined;
  }

  start(viewVersion: number | undefined): void {
    this.reset();
    this.composing = { viewVersion };
  }

  invalidate(): void {
    // Keep the native pre-edit session intact until its end event; clearing
    // the textarea now can turn its late confirmation into ordinary input.
    if (this.composing) this.composing.viewVersion = undefined;
  }

  end(text: string, viewVersion: number | undefined): void {
    const started = this.composing;
    this.reset();
    if (!text) return;
    // Some engines emit another ordinary insertText in the same commit turn.
    this.tail = {
      text,
      timer: setTimeout(() => {
        this.tail = undefined;
      }, 0)
    };
    if (started && viewVersion !== undefined && started.viewVersion === viewVersion)
      this.commit(text, viewVersion);
  }

  /** Returns whether the caller may clear the local textarea. */
  read(
    event: Pick<InputEvent, 'data' | 'inputType' | 'isComposing'>,
    value: string,
    viewVersion: number | undefined
  ): boolean {
    if (this.active || event.isComposing) return false;
    if (event.inputType === 'insertCompositionText' || event.inputType === 'insertFromComposition')
      return true;
    if (this.tail && event.inputType === 'insertText' && (event.data ?? value) === this.tail.text)
      return true;
    if (value && viewVersion !== undefined) this.commit(value, viewVersion);
    return true;
  }

  reset(): void {
    this.composing = undefined;
    if (this.tail) clearTimeout(this.tail.timer);
    this.tail = undefined;
  }
}
