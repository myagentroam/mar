import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { WEB_FETCH_MAX_BYTES } from './web-fetch-contracts.js';

const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
converter.use(gfm);

export function convertWebDocument(
  content: string,
  html: boolean
): { content: string; truncated: boolean } {
  const text = html ? converter.turndown(content) : content;
  const bytes = Buffer.from(text);
  const truncated = bytes.length > WEB_FETCH_MAX_BYTES;
  return {
    content: new TextDecoder().decode(bytes.subarray(0, WEB_FETCH_MAX_BYTES), {
      stream: truncated
    }),
    truncated
  };
}
