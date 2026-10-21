import {
  parseComposerTags,
  type ChannelOrigin,
  type ComposerAttachmentFile,
  type SessionMessageOrigin
} from '@myagentroam/protocol';
import { conversationPayload } from './conversation-history.js';

export function composerMessagePresentation(payload: unknown) {
  const value = conversationPayload(payload);
  const raw =
    typeof value?.text === 'string'
      ? value.text
      : typeof value?.content === 'string'
        ? value.content
        : '';
  const parts = parseComposerTags(raw);
  const files: ComposerAttachmentFile[] = [];
  let goal: 'start' | 'continue' | undefined;
  let scheduled = value?.source === 'SCHEDULED';
  let restarted = false;
  let channel: ChannelOrigin | undefined;
  let sessionOrigin: SessionMessageOrigin | undefined;
  const text = parts
    .map((part) => {
      if (part.kind === 'text') return part.text;
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
    goal,
    scheduled,
    ...(channel === undefined ? {} : { channel }),
    ...(sessionOrigin === undefined ? {} : { sessionOrigin }),
    ...(restarted ? { restarted: true } : {})
  };
}
