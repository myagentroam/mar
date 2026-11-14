import { z } from 'zod';

/** A model proxy is sensitive connection data, never part of a model summary. */
export const modelSocks5UrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const port = Number(url.port || 1080);
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      return (
        url.protocol === 'socks5:' &&
        url.hostname.length > 0 &&
        Number.isInteger(port) &&
        port > 0 &&
        port <= 65_535 &&
        (url.pathname === '' || url.pathname === '/') &&
        !url.search &&
        !url.hash &&
        (!password || Boolean(username)) &&
        new TextEncoder().encode(username).length <= 255 &&
        new TextEncoder().encode(password).length <= 255
      );
    } catch {
      return false;
    }
  }, 'A valid SOCKS5 proxy URL is required');

export const marAgentModelConnectionDetailsSchema = z
  .object({ socks5Url: modelSocks5UrlSchema.nullable() })
  .strict();
