import type {
  ApplyPatchFileResult,
  ApplyPatchPartialResult,
  ApplyPatchResult
} from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';

/** Keep event projection and persisted GC evidence on the same file-result contract. */
export function parseApplyPatchResult(value: unknown): ApplyPatchResult | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    value.files.length > TOOL_EXECUTION_LIMITS.patchMaxFiles ||
    !isRecord(value.totals)
  )
    return undefined;
  const files: ApplyPatchFileResult[] = [];
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !isPath(file.path) ||
      (file.operation !== 'added' &&
        file.operation !== 'modified' &&
        file.operation !== 'deleted' &&
        file.operation !== 'moved') ||
      (file.targetPath !== undefined && !isPath(file.targetPath)) ||
      (file.operation === 'moved' && !isPath(file.targetPath)) ||
      !isCount(file.addedLines) ||
      !isCount(file.deletedLines)
    )
      return undefined;
    files.push({
      path: file.path,
      operation: file.operation as ApplyPatchFileResult['operation'],
      ...(typeof file.targetPath === 'string' ? { targetPath: file.targetPath } : {}),
      addedLines: file.addedLines,
      deletedLines: file.deletedLines
    });
  }
  const totals = value.totals;
  if (
    !isCount(totals.files) ||
    !isCount(totals.addedLines) ||
    !isCount(totals.deletedLines) ||
    totals.files !== files.length ||
    totals.addedLines !== files.reduce((n, file) => n + file.addedLines, 0) ||
    totals.deletedLines !== files.reduce((n, file) => n + file.deletedLines, 0)
  )
    return undefined;
  return {
    files,
    totals: {
      files: totals.files,
      addedLines: totals.addedLines,
      deletedLines: totals.deletedLines
    }
  };
}

export function parseApplyPatchPartialResult(value: unknown): ApplyPatchPartialResult | undefined {
  const result = parseApplyPatchResult(value);
  if (
    !result?.files.length ||
    !isRecord(value) ||
    !isPath(value.failedFile) ||
    !Array.isArray(value.pendingFiles) ||
    !value.pendingFiles.every(isPath) ||
    result.files.length + value.pendingFiles.length + 1 > TOOL_EXECUTION_LIMITS.patchMaxFiles
  )
    return undefined;
  return { ...result, failedFile: value.failedFile, pendingFiles: [...value.pendingFiles] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
