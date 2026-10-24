import type { RunnerName } from '@myagentroam/protocol';

export interface NativeTranscriptMessage {
  readonly kind: 'message';
  readonly role: 'USER' | 'ASSISTANT';
  readonly text: string;
  /** Metadata only: Composer image bytes and local paths are never sent to Web. */
  readonly imageAttachments?: readonly NativeTranscriptImageAttachment[];
  readonly createdAt: number | null;
  readonly nativeId?: string;
  /** Runner-provided native Turn boundary for non-destructive branching. */
  readonly nativeTurnId?: string;
}

export interface NativeTranscriptToolCall {
  readonly kind: 'tool_call';
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly inputSummary: string | null;
  readonly inputTruncated: boolean;
  readonly outputSummary: string | null;
  readonly outputTruncated: boolean;
  readonly subagentResult?: NativeTranscriptSubagentResult;
  readonly toolCategory?: 'IMAGE_GENERATION';
  /** Metadata only: native transcript image bytes are never retained here. */
  readonly imageAttachments?: readonly NativeTranscriptImageAttachment[];
  readonly failed: boolean;
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptUnknown {
  readonly kind: 'unknown';
  readonly sourceEventType: string;
  readonly label: string;
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptReasoningSummary {
  readonly kind: 'reasoning_summary';
  readonly representation?: 'summary' | 'visible_thinking' | 'unspecified';
  readonly sections: readonly { readonly index: number; readonly text: string }[];
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptContextCompaction {
  readonly kind: 'context_compaction';
  readonly phase: 'COMPLETED';
  readonly summary: string | null;
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptImageAttachment {
  readonly name: string;
  readonly mime: string;
  readonly byteSize?: number;
  /** Runner-owned local artifact path; never sent to Web. */
  readonly localPath?: string;
  /** Stable source identity for a Runner-owned file or lazy reader. */
  readonly sourceId?: string;
  /** Loads image bytes only after an explicit preview request. */
  readonly read?: () => Promise<
    { readonly name: string; readonly mime: string; readonly dataBase64: string } | undefined
  >;
}

export type NativeTranscriptItem = (
  | NativeTranscriptMessage
  | NativeTranscriptToolCall
  | NativeTranscriptReasoningSummary
  | NativeTranscriptContextCompaction
  | NativeTranscriptUnknown
) & { readonly sourceItemId?: string; readonly rewindAfter?: string };

export interface NativeSessionHistory {
  readonly runner: RunnerName;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly digest: string;
  readonly items: readonly NativeTranscriptItem[];
  /**
   * Latest timestamp of a visible conversation or tool item.  Filesystem
   * metadata is deliberately excluded: runners can rewrite transcript-side
   * metadata without adding a user-visible conversation record.
   */
  readonly lastActivityAt: number;
  /** The bounded reader omitted bytes between its header and tail windows. */
  readonly truncated?: boolean;
  /** Opaque paging facts for reading the preceding newline-aligned JSONL window. */
  readonly windowStart?: number;
  readonly windowEnd?: number;
  readonly snapshotEnd?: number;
  readonly fileAnchor?: string;
  readonly anchorBytes?: number;
  /** The supplied page cursor no longer matched this transcript. */
  readonly cursorReset?: boolean;
  /** Page-size input used to derive the stable JSONL line window. */
  readonly windowReadLimit?: number;
}

export type PublicConversationItem = {
  readonly sourceItemId?: string;
  readonly itemId: string;
  readonly kind:
    | 'assistant_message'
    | 'reasoning'
    | 'tool_call'
    | 'command_execution'
    | 'user_input_request'
    | 'plan'
    | 'context_compaction'
    | 'file_change'
    | 'warning'
    | 'error'
    | 'unknown';
  readonly status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'DECLINED' | 'INTERRUPTED';
  readonly payload: Record<string, unknown>;
  readonly merge?: boolean;
  readonly append?: 'sections' | 'outputPreview' | 'outputSummary';
};

export interface NativeTranscriptSubagentResult {
  readonly agentId?: string;
  readonly taskId?: string;
  readonly taskType?: string;
}

export interface ParsedNativeTranscript {
  readonly externalSessionId?: string;
  readonly cwd: string;
  readonly title?: string;
  readonly items: readonly NativeTranscriptItem[];
}

export interface NativeUserInputQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly input: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'SHORT_TEXT';
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description: string | null;
  }[];
  readonly allowOther: boolean;
  readonly multiSelect: boolean;
}

export interface NativeTranscriptProjection {
  userText(text: string): string;
  planText(text: string): string | undefined;
  normalizeTool(call: NativeTranscriptToolCall):
    | {
        readonly kind: 'command_execution' | 'file_change' | 'tool_call';
        readonly payload: Record<string, unknown>;
      }
    | undefined;
  userInputQuestions(call: NativeTranscriptToolCall): readonly NativeUserInputQuestion[];
}

/** Fixed in-process ownership seam, not a runtime plugin registry. */
export interface NativeTranscriptAdapter {
  readonly runner: 'codex' | 'claude-code';
  transcriptRoot(): string;
  includesPath(path: string): boolean;
  parse(
    path: string,
    window: import('./native-jsonl-reader.js').JsonlBackwardWindow
  ): ParsedNativeTranscript | undefined;
  locateCandidates?(externalSessionId: string): Promise<readonly string[]>;
  createProjection(precedingItems: readonly NativeTranscriptItem[]): NativeTranscriptProjection;
}
