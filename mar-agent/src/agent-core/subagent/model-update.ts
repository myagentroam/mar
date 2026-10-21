import { escapeMarkupText, markupAttributes } from '../prompts/markup.js';
import { TOOL_EXECUTION_LIMITS } from '../tools/execution-limits.js';
import type { SubagentTaskSnapshot } from './contracts.js';

export function renderSubagentUpdate(snapshot: SubagentTaskSnapshot, truncated = false): string {
  const attributes = (values: object): string =>
    markupAttributes(
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          if (value === undefined) return [key, undefined];
          let bounded = '';
          let count = 0;
          for (const point of String(value)) {
            if (count++ === 256) {
              truncated = true;
              break;
            }
            bounded += point;
          }
          return [key, bounded];
        })
      )
    );
  const root =
    '<mar_subagent_update' +
    attributes({
      agentId: snapshot.agentId,
      status: snapshot.status,
      modelId: snapshot.modelId,
      modelName: snapshot.modelName,
      reasoningEffort: snapshot.reasoningEffort,
      messageId: snapshot.messageId,
      turnId: snapshot.turnId,
      deliveryStatus: snapshot.deliveryStatus
    });
  const close = '</mar_subagent_update>';
  let remaining =
    TOOL_EXECUTION_LIMITS.subagentUpdateMaxBytes -
    Buffer.byteLength(root + ' truncated="false">\n' + close);
  const lines: string[] = [];
  const field = (name: string, value: string, metadata: object = {}, limit = remaining): void => {
    let attrs = attributes(metadata);
    const overhead = Buffer.byteLength('  <' + name + attrs + '></' + name + '>\n');
    if (overhead > remaining) {
      truncated = true;
      return;
    }
    let budget = Math.min(limit, remaining - overhead);
    let text = '';
    let clipped = false;
    for (const point of value) {
      const encoded = escapeMarkupText(point);
      const bytes = Buffer.byteLength(encoded);
      if (bytes > budget) {
        clipped = true;
        break;
      }
      text += encoded;
      budget -= bytes;
    }
    if (clipped) {
      truncated = true;
      if ('truncated' in metadata) attrs = attributes({ ...metadata, truncated: true });
    }
    const opening = '  <' + name + attrs;
    const line = text === '' ? opening + ' />\n' : opening + '>' + text + '</' + name + '>\n';
    remaining -= Buffer.byteLength(line);
    lines.push(line);
  };
  // Preserve failure/permission facts before spending the remaining budget on result text.
  if (snapshot.errorCode !== undefined || snapshot.errorMessage !== undefined)
    field('error', snapshot.errorMessage ?? '', { code: snapshot.errorCode }, 1024);
  if (snapshot.permissionStop)
    field(
      'permission_stop',
      snapshot.permissionStop.reason,
      { action: snapshot.permissionStop.action, ...snapshot.permissionStop.source },
      1024
    );
  field('description', snapshot.description, {}, 1024);
  if (snapshot.latestMessage) {
    const { text, ...metadata } = snapshot.latestMessage;
    truncated ||= metadata.truncated;
    field('message', text, metadata, TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes);
  }
  if (snapshot.summary !== undefined) field('summary', snapshot.summary);
  for (const path of snapshot.changedFiles ?? []) field('changed_file', path);
  for (const text of snapshot.verification ?? []) field('verification', text);
  for (const { path, startLine, endLine } of snapshot.evidence ?? [])
    field('evidence', path, { startLine, endLine });
  if (snapshot.latestActivity) field('activity', '', snapshot.latestActivity);
  return root + ' truncated="' + String(truncated) + '">\n' + lines.join('') + close;
}
