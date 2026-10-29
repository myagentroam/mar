import type { ExecutionPresentation } from '@myagentroam/protocol';

type Execution = ExecutionPresentation['execution'];
const MAX_BYTES = 128 * 1024;

function tail(text: string, limit: number): string {
  if (limit === 0) return '';
  const result = text.slice(-limit);
  const first = result.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? result.slice(1) : result;
}

/** Keep public execution output bounded without copying an unbounded source. */
export function boundExecutionPresentation(execution: Execution): {
  presentation: ExecutionPresentation;
  truncated: boolean;
} {
  let truncated = (execution.output?.length ?? 0) > 4;
  const output = execution.output?.slice(0, 4).map((block) => {
    if (block.text.length > 10_000) truncated = true;
    return { ...block, text: tail(block.text, 10_000) };
  });
  const detail: Execution = {
    ...execution,
    ...(output === undefined ? {} : { output }),
    ...(execution.truncation === undefined ? {} : { truncation: { ...execution.truncation } })
  };
  if (truncated)
    detail.truncation = { ...detail.truncation, output: detail.truncation?.output ?? 'HEAD' };
  const presentation: ExecutionPresentation = { kind: 'EXECUTION', execution: detail };
  const size = () => Buffer.byteLength(JSON.stringify(presentation));
  for (const block of [...(detail.output ?? [])].reverse()) {
    if (size() <= MAX_BYTES) break;
    const source = block.text;
    detail.truncation = { ...detail.truncation, output: detail.truncation?.output ?? 'HEAD' };
    truncated = true;
    let low = 0;
    let high = source.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      block.text = tail(source, middle);
      if (size() <= MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    block.text = tail(source, low);
  }
  return { presentation, truncated };
}

/** Project only the stream facts actually supplied by the runner. */
export function shellExecution(
  output: string | undefined,
  sourceTruncated = false
): ExecutionPresentation {
  return boundExecutionPresentation({
    kind: 'SHELL',
    ...(output === undefined ? {} : { output: [{ channel: 'COMBINED', text: output }] }),
    ...(sourceTruncated ? { truncation: { output: 'SOURCE' } } : {})
  }).presentation;
}
