export interface ComputerUseSupport {
  readonly available: boolean;
  readonly reasonCode: string | null;
  readonly platform: 'windows' | 'macos' | 'linux';
  readonly backend: 'PYAUTOGUI';
  readonly runtimeExecutable: string;
  readonly supportsScreenshot: boolean;
  readonly supportsInput: boolean;
  readonly supportsUnicodePaste: boolean;
  readonly supportsPrimaryDisplay: boolean;
}

export interface ComputerUseConfiguration {
  readonly enabled: boolean;
  readonly runtimeExecutable: string;
}

export interface ComputerUseInput {
  readonly code: string;
  readonly basedOnObservationId?: string;
  readonly timeoutMs: number;
  readonly yieldMs?: number;
}

export interface ComputerUseWaitInput {
  readonly taskId: string;
  readonly action: 'poll' | 'cancel';
  readonly yieldMs: number;
}

export type ComputerUseTaskResult =
  | { readonly taskId: string; readonly status: 'RUNNING' | 'STOPPING' }
  | (ComputerUseResult & { readonly taskId: string; readonly status: 'COMPLETED' });

export interface ComputerUseResult {
  readonly outcome: 'SUCCEEDED' | 'OUTCOME_UNKNOWN';
  readonly observationId: string;
  readonly runtimeGeneration: number;
  readonly logs: string[];
  readonly images?: { readonly mimeType: string; readonly dataBase64: string }[];
  readonly message?: string;
  readonly cleanupFailed?: boolean;
}

export class ComputerUseError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'ComputerUseError';
    this.code = code;
  }
}
