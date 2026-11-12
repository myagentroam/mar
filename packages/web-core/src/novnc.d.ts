declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      channel: unknown,
      options: {
        manualClipboard: boolean;
        requestDrivenUpdates: boolean;
        allowedEncodings: number[];
      }
    );
    viewOnly: boolean;
    qualityLevel: number;
    sendText(text: string): boolean;
    sendKey(keysym: number, code: string, down?: boolean): void;
    scaleViewport: boolean;
    disconnect(): void;
    clipboardPasteFrom(text: string): void;
  }
}
