import {
  parseComposerTags,
  type ChannelOrigin,
  type ComposerAttachmentFile,
  type ComposerReference,
  type SessionMessageOrigin
} from '@myagentroam/protocol';
import { conversationPayload } from './conversation-history.js';

export function composerMessageInputText(payload: unknown): string {
  const value = conversationPayload(payload);
  return typeof value?.text === 'string'
    ? value.text
    : typeof value?.content === 'string'
      ? value.content
      : '';
}

/** Copies the body and explicit references as text, without transport metadata. */
export function composerMessageCopyText(payload: unknown): string {
  const parts = parseComposerTags(composerMessageInputText(payload));
  const fragments = parts.map((part) => {
    if (part.kind === 'text') return part.text;
    if (part.kind === 'mar_references')
      return part.payload.references
        .map((reference) => {
          if (reference.type === 'quote') return `${reference.label}\n${reference.text}`;
          return reference.type === 'session' ? reference.label : reference.path;
        })
        .join('\n');
    if (part.kind === 'mar_steer') return part.payload.message;
    if (part.kind === 'mar_goal_start' || part.kind === 'mar_schedule')
      return part.payload.objective;
    return undefined;
  });

  // Remove one separator for standalone hidden fragments, never trim body whitespace.
  fragments.forEach((fragment, index) => {
    if (fragment !== undefined) return;
    const before = parts[index - 1];
    const after = parts[index + 1];
    const lineStart =
      before === undefined || (before.kind === 'text' && before.text.endsWith('\n'));
    const lineEnd = after === undefined || (after.kind === 'text' && /^\r?\n/u.test(after.text));
    if (!lineStart || !lineEnd) return;
    const previousText = fragments[index - 1];
    if (previousText?.endsWith('\n')) fragments[index - 1] = previousText.replace(/\r?\n$/u, '');
    else {
      const nextText = fragments[index + 1];
      if (nextText !== undefined) fragments[index + 1] = nextText.replace(/^\r?\n/u, '');
    }
  });
  return fragments.join('');
}

export function composerMessagePresentation(payload: unknown) {
  const value = conversationPayload(payload);
  const parts = parseComposerTags(composerMessageInputText(payload));
  const files: ComposerAttachmentFile[] = [];
  const references: ComposerReference[] = [];
  let goal: 'start' | 'continue' | undefined;
  let scheduled = value?.source === 'SCHEDULED';
  let restarted = false;
  let channel: ChannelOrigin | undefined;
  let sessionOrigin: SessionMessageOrigin | undefined;
  const text = parts
    .map((part) => {
      if (part.kind === 'text') return part.text;
      if (part.kind === 'mar_references') {
        references.push(...part.payload.references);
        return '';
      }
      if (part.kind === 'mar_steer') return part.payload.message;
      if (part.kind === 'mar_channel') {
        channel ??= part.payload;
        return '';
      }
      if (part.kind === 'mar_session_origin') {
        sessionOrigin ??= part.payload;
        return '';
      }
      if (part.kind === 'mar_restart') {
        restarted = true;
        return '';
      }
      if (part.kind === 'mar_goal_start') {
        goal = 'start';
        return part.payload.objective;
      }
      if (part.kind === 'mar_goal_continue') {
        goal = 'continue';
        return '';
      }
      if (part.kind === 'mar_schedule') {
        scheduled = true;
        return part.payload.objective;
      }
      if (part.kind === 'mar_attachments')
        files.push(
          ...part.payload.files.map((file) => ({
            name: file.name,
            mime: file.mime,
            path: file.workspacePath ?? file.path
          }))
        );
      return '';
    })
    .join('')
    .trim();
  return {
    text,
    files,
    references,
    goal,
    scheduled,
    ...(channel === undefined ? {} : { channel }),
    ...(sessionOrigin === undefined ? {} : { sessionOrigin }),
    ...(restarted ? { restarted: true } : {})
  };
}
