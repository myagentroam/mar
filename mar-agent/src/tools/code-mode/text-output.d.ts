export interface CapturedText {
  text: string;
  originalBytes: number;
  retainedBytes: number;
  droppedBytes: number;
}

/** Source-consumer types for the JS module also loaded by worker processes. */
export class BoundedTextOutput {
  constructor(maximumBytes: number, separator?: string, retention?: 'head' | 'tail');
  maximumBytes: number;
  separator: string;
  retention: 'head' | 'tail';
  append(value: string, originalBytes?: number): void;
  snapshot(): CapturedText;
  drain(): CapturedText;
}

export function renderCapturedText(snapshot: CapturedText, imageCount?: number): string;
