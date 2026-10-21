import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewImageTool } from '../../src/agent-core/tools/local/view-image.js';
import { WorkspacePathResolver } from '../../src/agent-core/tools/shared/path-resolver.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(data: Buffer) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mar-image-integrity-'));
  roots.push(root);
  const path = join(root, 'image.bin');
  await fs.writeFile(path, data);
  return { path, tool: new ViewImageTool(new WorkspacePathResolver(root)) };
}

describe('local image file integrity', () => {
  it('returns complete PNG bytes without conversion', async () => {
    const { tool } = await fixture(png);
    const result = await tool.execute({ path: 'image.bin' });
    expect(result.images).toEqual([{ mimeType: 'image/png', dataBase64: png.toString('base64') }]);
  });

  it.each([8, 20, 40, png.length - 12, png.length - 1])(
    'rejects an unfinished PNG prefix of %s bytes before publishing pixels',
    async (bytes) => {
      const { tool } = await fixture(png.subarray(0, bytes));
      await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
        code: 'MAR_AGENT_IMAGE_INCOMPLETE',
        message: expect.stringContaining('writer')
      });
    }
  );

  it('rejects a malformed chunk length even when an IEND suffix exists', async () => {
    const malformed = Buffer.from(png);
    malformed.writeUInt32BE(0xffffffff, 33);
    const { tool } = await fixture(malformed);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });

  it.each(['growth', 'same-size rewrite'])(
    'rejects %s during its read even when the captured PNG is complete',
    async (change) => {
      const { tool, path } = await fixture(png);
      const { open: originalOpen } =
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.readFile.bind(handle);
        vi.spyOn(handle, 'readFile').mockImplementationOnce(async () => {
          const data = await originalRead();
          const updated =
            change === 'growth' ? Buffer.concat([png, Buffer.from([0])]) : Buffer.from(png);
          updated[updated.length - 1] = updated[updated.length - 1]! ^ 1;
          await fs.writeFile(path, updated);
          await fs.utimes(path, new Date(0), new Date(0));
          return data;
        });
        return handle;
      });
      await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
        code: 'MAR_AGENT_IMAGE_INCOMPLETE'
      });
    }
  );

  it('honors cancellation during the post-read stat without publishing pixels', async () => {
    const { tool } = await fixture(png);
    const controller = new AbortController();
    const reason = new Error('fixture cancellation');
    const { open: originalOpen } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const stat = await originalStat(options);
        if (++calls === 2) controller.abort(reason);
        return stat;
      });
      return handle;
    });
    await expect(tool.execute({ path: 'image.bin' }, controller.signal)).rejects.toBe(reason);
  });

  it('preserves complete JPEG bytes without conversion', async () => {
    const data = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==',
      'base64'
    );
    const { tool } = await fixture(data);
    expect((await tool.execute({ path: 'image.bin' })).images).toEqual([
      { mimeType: 'image/jpeg', dataBase64: data.toString('base64') }
    ]);
  });

  it('preserves complete WebP bytes', async () => {
    const data = Buffer.from(
      'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=',
      'base64'
    );
    const { tool } = await fixture(data);
    expect((await tool.execute({ path: 'image.bin' })).images).toEqual([
      { mimeType: 'image/webp', dataBase64: data.toString('base64') }
    ]);
  });

  it('does not mistake an EOI inside JPEG metadata for a complete image', async () => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 6, 0, 0, 0xff, 0xd9]);
    const { tool } = await fixture(data);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });

  it('preserves WebP bytes with an odd-sized padded metadata chunk', async () => {
    const webp = Buffer.from(
      'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=',
      'base64'
    );
    const metadata = Buffer.concat([Buffer.from('JUNK'), Buffer.from([1, 0, 0, 0, 42, 0])]);
    const data = Buffer.concat([webp.subarray(0, 12), metadata, webp.subarray(12)]);
    data.writeUInt32LE(data.length - 8, 4);
    const { tool } = await fixture(data);
    expect((await tool.execute({ path: 'image.bin' })).images).toEqual([
      { mimeType: 'image/webp', dataBase64: data.toString('base64') }
    ]);
  });

  it.each(['missing IHDR', 'missing IDAT', 'zero width', 'nonempty IEND'])(
    'rejects a PNG with %s',
    async (condition) => {
      let data = Buffer.from(png);
      if (condition === 'missing IHDR')
        data = Buffer.concat([data.subarray(0, 8), data.subarray(33)]);
      else if (condition === 'missing IDAT')
        data = Buffer.concat([data.subarray(0, 33), data.subarray(data.length - 12)]);
      else if (condition === 'zero width') data.writeUInt32BE(0, 16);
      else data.writeUInt32BE(1, data.length - 12);
      const { tool } = await fixture(data);
      await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
        code: 'MAR_AGENT_IMAGE_INCOMPLETE'
      });
    }
  );

  it('rejects a WebP chunk extending beyond an otherwise complete RIFF container', async () => {
    const data = Buffer.from(
      'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=',
      'base64'
    );
    data.writeUInt32LE(0xffff, 16);
    const { tool } = await fixture(data);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });

  it.each([
    {
      name: 'JPEG without its end marker',
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])
    },
    {
      name: 'WebP shorter than its RIFF declaration',
      data: Buffer.from('5249464610000000574542505650384c', 'hex')
    }
  ])('rejects $name', async ({ data }) => {
    const { tool } = await fixture(data);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });
});
