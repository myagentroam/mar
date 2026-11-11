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
