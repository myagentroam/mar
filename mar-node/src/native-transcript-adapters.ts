import type { RunnerName } from '@myagentroam/protocol';
import type { NativeTranscriptAdapter } from './native-transcript-model.js';
import { codexNativeTranscriptAdapter } from './runner/codex/native-transcript.js';
import { claudeNativeTranscriptAdapter } from './runner/claude/native-transcript.js';

const adapters: Partial<Record<RunnerName, NativeTranscriptAdapter>> = {
  codex: codexNativeTranscriptAdapter,
  'claude-code': claudeNativeTranscriptAdapter
};

export function nativeTranscriptAdapter(runner: RunnerName): NativeTranscriptAdapter | undefined {
  return adapters[runner];
}
