import { open } from 'node:fs/promises';
import { basename } from 'node:path';
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

export async function imageAttachments(paths, translate) {
  const attachments = [];
  let total = 0;
  for (const path of paths) {
    let file;
    try {
      file = await open(path, 'r');
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > 5 * 1024 * 1024)
        throw new Error('IMAGE_INVALID');
      const parts = [];
      let size = 0;
      for await (const part of file.createReadStream({ autoClose: false })) {
        size += part.length;
        total += part.length;
        if (size > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
        parts.push(part);
      }
      const data = Buffer.concat(parts);
      const mime = imageMime(data);
      if (mime === undefined) throw new Error('IMAGE_INVALID');
      attachments.push({ name: basename(path), mime, dataBase64: data.toString('base64') });
    } catch {
      throw new MarctlError(translate('errors.sessionImageInvalid'), {
        code: 'MARCTL_SESSION_INPUT_INVALID'
      });
    } finally {
      await file?.close();
    }
  }
  return attachments;
}

function imageMime(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
}
