import { isAbsolute, resolve } from 'node:path';
import { AgentError } from '../../error.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import { sourcePreview } from '../input-diagnostics/source-preview.js';

export type PatchHunk = {
  changeContext?: string;
  oldLines: string[];
  patchLines: Array<{
    kind: 'context' | 'addition' | 'deletion';
    value: string;
  }>;
  addedLines: number;
  deletedLines: number;
  anchor: boolean;
};

export type PatchChange =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; targetPath?: string; hunks: PatchHunk[] };

const beginMarker = '*** Begin Patch';
const endMarker = '*** End Patch';
const addHeader = '*** Add File: ';
const updateHeader = '*** Update File: ';
const deleteHeader = '*** Delete File: ';
const moveHeader = '*** Move to: ';

export function parsePatch(patch: string): PatchChange[] {
  if (typeof patch !== 'string')
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Patch must be a string.');
  if (Buffer.byteLength(patch) > TOOL_EXECUTION_LIMITS.patchMaxBytes)
    throw new AgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Patch exceeds the input byte limit.');
  return new FreeformPatchParser(patch).parse();
}

class FreeformPatchParser {
  readonly #lines: string[];
  readonly #lineOffsets: number[] = [];
  readonly #claimed = new Set<string>();
  #index = 1;

  constructor(patch: string) {
    const sourceLines = patch.split('\n');
    let offset = 0;
    this.#lines = sourceLines.map((line, index) => {
      this.#lineOffsets.push(offset);
      offset += line.length + 1;
      return index < sourceLines.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line;
    });
    if (patch.endsWith('\n')) this.#lines.pop();
  }

  parse(): PatchChange[] {
    for (const [index, line] of this.#lines.entries()) {
      const column = line.indexOf('\r');
      if (column !== -1)
        this.#fail('Patch contains unsupported bare carriage returns.', index, column);
    }
    this.#marker(0, beginMarker, 'first');
    this.#marker(this.#lines.length - 1, endMarker, 'last');
    if (this.#lines.length < 3) this.#fail('Patch must contain at least one operation.', 1);
    const changes: PatchChange[] = [];
    while (this.#index < this.#lines.length - 1) {
      const headerIndex = this.#index++;
      const header = this.#lines[headerIndex]!;
      if (header.startsWith(addHeader)) {
        const path = this.#path(headerIndex, addHeader);
        const lines: string[] = [];
        while (this.#hasBodyLine()) {
          const index = this.#index++;
          const line = this.#lines[index]!;
          if (!line.startsWith('+')) this.#fail('Added file lines must start with +.', index);
          lines.push(line.slice(1));
        }
        changes.push({ kind: 'add', path, lines });
      } else if (header.startsWith(deleteHeader)) {
        changes.push({ kind: 'delete', path: this.#path(headerIndex, deleteHeader) });
      } else if (header.startsWith(updateHeader)) {
        const path = this.#path(headerIndex, updateHeader);
        let targetPath: string | undefined;
        if (this.#lines[this.#index]?.startsWith(moveHeader)) {
          targetPath = this.#path(this.#index++, moveHeader);
        }
        const hunks: PatchHunk[] = [];
        while (this.#index < this.#lines.length - 1 && this.#lines[this.#index]!.startsWith('@@'))
          hunks.push(this.#hunk());
        if (!hunks.length && !targetPath)
          this.#fail('Update operations must contain hunks or move a file.', headerIndex);
        changes.push({ kind: 'update', path, ...(targetPath ? { targetPath } : {}), hunks });
      } else {
        this.#fail(
          "Expected an operation header: '*** Add File: <path>', '*** Update File: <path>', or '*** Delete File: <path>'.",
          headerIndex,
          Math.max(
            ...[addHeader, updateHeader, deleteHeader].map((prefix) =>
              commonPrefixLength(header, prefix)
            )
          )
        );
      }
      if (changes.length > TOOL_EXECUTION_LIMITS.patchMaxFiles)
        throw new AgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Patch exceeds the file limit.');
    }
    if (
      !changes.some(
        (change) =>
          change.kind !== 'update' || change.targetPath || change.hunks.some((hunk) => !hunk.anchor)
      )
    )
      this.#fail(
        'Patch must change or move at least one file. No additions, deletions, or moves were supplied; context-only hunks only validate existing lines. Use read to inspect a file, or supply -old/+new lines to edit it.',
        1
      );
    return changes;
  }

  #marker(index: number, marker: string, position: string) {
    const line = this.#lines[index]!;
    const trimmed = line.trim();
    if (trimmed === marker || trimmed === `${marker} ***`) return;
    const leading = line.length - line.trimStart().length;
    const expected = trimmed.startsWith(`${marker} ***`) ? `${marker} ***` : marker;
    this.#fail(
      `Expected ${position} line to be '${marker}' (optional trailing ' ***').`,
      index,
      leading + commonPrefixLength(trimmed, expected)
    );
  }

  #path(index: number, prefix: string) {
    const path = this.#lines[index]!.slice(prefix.length);
    if (!path || path.trim() !== path) {
      const column =
        path.trimStart() !== path ? prefix.length : prefix.length + path.trimEnd().length;
      this.#fail('Patch paths must be non-empty and unpadded.', index, column);
    }
    const key = isAbsolute(path) ? resolve(path) : resolve('/', path);
    if (this.#claimed.has(key))
      this.#fail('Patch contains duplicate or overlapping paths.', index, prefix.length);
    this.#claimed.add(key);
    return path;
  }

  #hasBodyLine() {
    return this.#index < this.#lines.length - 1 && !this.#lines[this.#index]!.startsWith('*** ');
  }

  #hunk(): PatchHunk {
    const index = this.#index++;
    const header = this.#lines[index]!;
    let changeContext: string | undefined;
    if (header !== '@@') {
      if (!header.startsWith('@@ '))
        this.#fail('Patch change context headers must use @@ or @@ <context>.', index, 2);
      changeContext = header.slice(3);
      if (!changeContext.trim()) this.#fail('Patch change context must be non-empty.', index, 3);
    }
    const oldLines: string[] = [];
    const patchLines: PatchHunk['patchLines'] = [];
    let addedLines = 0;
    let deletedLines = 0;
    while (this.#hasBodyLine() && !this.#lines[this.#index]!.startsWith('@@')) {
      const lineIndex = this.#index++;
      const line = this.#lines[lineIndex]!;
      const value = line.slice(1);
      if (line.startsWith(' ')) {
        oldLines.push(value);
        patchLines.push({ kind: 'context', value });
      } else if (line.startsWith('+')) {
        patchLines.push({ kind: 'addition', value });
        addedLines++;
      } else if (line.startsWith('-')) {
        oldLines.push(value);
        patchLines.push({ kind: 'deletion', value });
        deletedLines++;
      } else this.#fail('Patch hunk lines must start with space, +, or -.', lineIndex);
    }
    if (!oldLines.length) this.#fail('Insertion hunks require context.', index);
    return {
      ...(changeContext === undefined ? {} : { changeContext }),
      oldLines,
      patchLines,
      addedLines,
      deletedLines,
      anchor: !addedLines && !deletedLines
    };
  }

  #fail(message: string, index: number, characterOffset = 0): never {
    const source = this.#lines[index]!;
    const line = index + 1;
    const column = characterCount(source.slice(0, characterOffset)) + 1;
    const offset = this.#lineOffsets[index]! + characterOffset;
    const preview = sourcePreview(source, column);
    const gutter = String(line);
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      `Patch syntax error at line ${line}, column ${column}: ${message}\n${gutter} | ${preview.text}\n${' '.repeat(gutter.length)} | ${' '.repeat(preview.caret)}^`,
      { details: { line, column, offset } }
    );
  }
}

function commonPrefixLength(actual: string, expected: string) {
  let index = 0;
  while (index < actual.length && index < expected.length && actual[index] === expected[index])
    index++;
  return index;
}

function characterCount(value: string) {
  let count = 0;
  for (let index = 0; index < value.length; index++, count++) {
    if (value.codePointAt(index)! > 0xffff) index++;
  }
  return count;
}
