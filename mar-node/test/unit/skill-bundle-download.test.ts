import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadSkillBundle } from '../../src/service/skill-bundle-download.js';

const downloads: Awaited<ReturnType<typeof downloadSkillBundle>>[] = [];
afterEach(async () => {
  await Promise.all(downloads.splice(0).map((bundle) => bundle.dispose()));
});

function fixture() {
  return [
    {
      path: 'SKILL.md',
      contentBase64: Buffer.from('---\nname: review\ndescription: Review code\n---\n').toString(
        'base64'
      )
    },
    {
      path: 'scripts/quoted "路径" 😀.bin',
      contentBase64: Buffer.from(Array.from({ length: 1_027 }, (_, index) => index % 256)).toString(
        'base64'
      )
    },
    { path: 'empty', contentBase64: '' }
  ];
}

function contentHash(files: ReturnType<typeof fixture>) {
  return createHash('sha256')
    .update(files.map((file) => `${file.path}\0${file.contentBase64}`).join('\0'))
    .digest('hex');
}

function stream(text: string, chunkSize = 7) {
  const bytes = Buffer.from(text);
  return Readable.toWeb(
    Readable.from(
      (function* () {
        for (let offset = 0; offset < bytes.length; offset += chunkSize)
          yield bytes.subarray(offset, offset + chunkSize);
      })()
    )
  ) as ReadableStream<Uint8Array>;
}

describe('streaming Skill bundle download', () => {
  it.each([1, 2, 7, 65_536])(
    'decodes chunk boundaries of %s bytes and keeps repeatable disk-backed file sources',
    async (chunkSize) => {
      const files = fixture();
      const bundle = await downloadSkillBundle(
        stream(JSON.stringify({ schemaVersion: 1, files }), chunkSize),
        contentHash(files)
      );
      downloads.push(bundle);
      expect(bundle.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
      for (const [index, file] of bundle.files.entries()) {
        const expected = Buffer.from(files[index]!.contentBase64, 'base64');
        for (let copy = 0; copy < 2; copy += 1) {
          const chunks: Buffer[] = [];
          for await (const chunk of file.open()) chunks.push(Buffer.from(chunk));
          expect(Buffer.concat(chunks)).toEqual(expected);
        }
      }
      await bundle.dispose();
      await expect(Readable.from(bundle.files[0]!.open()).toArray()).rejects.toMatchObject({
        code: 'ENOENT'
      });
    }
  );

  it.each([
    'missing-skill',
    'duplicate',
    'forged-metadata',
    'invalid-base64',
    'bad-padding',
    'hash-mismatch',
    'truncated',
    'trailing-data',
    'wrong-schema'
  ])('rejects %s without returning an installable bundle', async (failure) => {
    let files = fixture();
    if (failure === 'missing-skill') files = files.slice(1);
    if (failure === 'duplicate') files.push(files[0]!);
    if (failure === 'forged-metadata')
      files.push({ path: '.mar-skill-install.json', contentBase64: 'e30=' });
    if (failure === 'invalid-base64') files[0]!.contentBase64 = 'not base64';
    if (failure === 'bad-padding') files[0]!.contentBase64 = 'YQ==YQ==';
    let json = JSON.stringify({ schemaVersion: failure === 'wrong-schema' ? 2 : 1, files });
    if (failure === 'truncated') json = json.slice(0, -3);
    if (failure === 'trailing-data') json += '{}';
    const hash = failure === 'hash-mismatch' ? 'f'.repeat(64) : contentHash(files);
    await expect(downloadSkillBundle(stream(json, 1), hash)).rejects.toThrow(
      'SKILL_CONTENT_INVALID'
    );
  });

  it('cancels an unfinished response after malformed framing', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"wrong":'));
      },
      cancel() {
        cancelled = true;
      }
    });
    await expect(downloadSkillBundle(body, 'a'.repeat(64))).rejects.toThrow(
      'SKILL_CONTENT_INVALID'
    );
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('does not impose a file-count limit', async () => {
    const files = fixture();
    for (let index = 0; index < 1_000; index += 1)
      files.push({ path: `files/${index}`, contentBase64: '' });
    const bundle = await downloadSkillBundle(
      stream(JSON.stringify({ schemaVersion: 1, files }), 65_536),
      contentHash(files)
    );
    downloads.push(bundle);
    expect(bundle.files).toHaveLength(1_003);
  });
});
