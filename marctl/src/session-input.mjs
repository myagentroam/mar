import { open } from 'node:fs/promises';
import { MarctlError } from './errors.mjs';

export async function messageContent(
  { message, messageFile: path },
  stdin,
  limit,
  translate,
  diagnostic = false
) {
  let file;
  try {
    let content = message;
    if (content === undefined) {
      const input =
        path === '-'
          ? stdin
          : (file = await open(path, 'r')).createReadStream({ autoClose: false });
      const parts = [];
      let bytes = 0;
      for await (const part of input) {
        const chunk = Buffer.from(part);
        bytes += chunk.length;
        if (bytes > limit * 4) throw new Error('MESSAGE_TOO_LONG');
        parts.push(chunk);
      }
      content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
    }
    if (content.trim().length === 0 || content.length > limit) throw new Error('MESSAGE_INVALID');
    return content;
  } catch (error) {
    throw new MarctlError(translate('errors.sessionMessageInvalid'), {
      code: 'MARCTL_SESSION_INPUT_INVALID',
      ...(diagnostic
        ? {
            details: `${path === undefined ? 'message' : path === '-' ? 'stdin' : 'message-file'}: provide non-blank UTF-8 text of at most ${limit} characters.${typeof error.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? ' File error: ' + error.code + '.' : ''}`
          }
        : {})
    });
  } finally {
    await file?.close();
  }
}
