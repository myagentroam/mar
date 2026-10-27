import {
  compactExtensionMessages,
  compactExtensionResult,
  compactExtensionDiagnostic,
  type ExtensionCompactContext,
  type ExtensionCompactDiagnostic,
  type ExtensionCompactResult
} from '../extensions/compaction.js';
import type { SessionModelMessage } from '../session/model-request.js';
import { buildCompactionMessages } from '../runtime/compaction/history.js';
import type { CompactionOperation } from '../runtime/compaction/operation.js';
import type { ModelRequestUsage } from '../model/usage-observer.js';

/** Bounds Extension diagnostics and validates its candidate before native fallback. */
export function createExecutionCompactExtension(ports: {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  hasInterceptor(): boolean;
  invoke(
    context: Omit<ExtensionCompactContext, 'operationId'>,
    signal: AbortSignal
  ): Promise<ExtensionCompactResult | undefined>;
  reportUsage?: (usage: ModelRequestUsage) => void | Promise<void>;
}) {
  return async (
    history: readonly SessionModelMessage[],
    reason: 'manual' | 'automatic',
    focus: string | undefined,
    compaction: CompactionOperation
  ): Promise<ExtensionCompactResult | undefined> => {
    if (!ports.hasInterceptor()) return undefined;
    const summaryTokenBudget = Math.min(
      10_000,
      ports.maxOutputTokens,
      Math.max(1, Math.floor(ports.contextWindowTokens / 4))
    );
    let diagnosticReports = 0;
    let acceptsDiagnostics = true;
    try {
      const result = await compaction.generate((signal) =>
        ports.invoke(
          Object.freeze({
            reason,
            messages: compactExtensionMessages(history),
            ...(focus === undefined ? {} : { focus }),
            summaryTokenBudget,
            getPrompt: () => buildCompactionMessages('')[1]!.content,
            reportModelUsage: ports.reportUsage,
            reportDiagnostic: async (value: ExtensionCompactDiagnostic) => {
              if (!acceptsDiagnostics || ++diagnosticReports > 8) return;
              try {
                const diagnostic = compactExtensionDiagnostic(value);
                if (diagnostic) await compaction.observeExtension(diagnostic);
              } catch {
                /* Diagnostic failures must not change compaction or fallback. */
              }
            }
          }),
          signal
        )
      );
      compaction.signal.throwIfAborted();
      const handled = compactExtensionResult(result, summaryTokenBudget);
      await compaction.finishExtension(
        handled ? 'HANDLED' : result === undefined ? 'DECLINED' : 'INVALID_RESULT'
      );
      return handled;
    } catch {
      await compaction.finishExtension('FAILED');
      compaction.signal.throwIfAborted();
      return undefined;
    } finally {
      acceptsDiagnostics = false;
    }
  };
}
