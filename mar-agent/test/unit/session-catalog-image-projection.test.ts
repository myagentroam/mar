import { expect, it, vi } from 'vitest';
import { createSessionCatalog, imageMetadata } from '../../src/session/catalog.js';

const reference = {
  name: 'diagram.png',
  mimeType: 'image/png',
  byteSize: 13,
  resourceInputVersion: 1,
  resourceId: 'a'.repeat(64),
  sha256: 'b'.repeat(64)
};

it('projects logical v2 image identities while retaining legacy and invalid degradation', async () => {
  const valid = {
    name: 'valid.png',
    mimeType: 'image/png',
    byteSize: 4,
    resourceInputVersion: 1,
    resourceId: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    dataBase64: 'private-pixels'
  };
  const readInputImage = vi.fn(async () => undefined);
  const catalog = createSessionCatalog(
    {
      readInputImage,
      readPage: async () => ({
        records: [
          {
            type: 'turn.user',
            recordId: 'r',
            sequence: 1,
            timestamp: 'now',
            sessionId: 's',
            executionId: 'e',
            turnId: 't',
            payload: {
              prompt: 'inspect',
              images: [
                { name: 'legacy.png', mimeType: 'image/png', byteSize: 1 },
                { ...valid, name: 'invalid.png', resourceId: '../bad' },
                valid
              ]
            }
          }
        ]
      })
    } as never,
    true
  );
  const history = await catalog.history('s');
  expect(history.entries[0]).toMatchObject({
    images: [
      { name: 'legacy.png', readable: false },
      { name: 'invalid.png', readable: false },
      { name: 'valid.png', readable: true }
    ]
  });
  expect(JSON.stringify(history)).not.toContain('private-pixels');
  expect(readInputImage).not.toHaveBeenCalled();
  await expect(catalog.readImage('s', { sequence: 1, imageIndex: 2 })).resolves.toBeUndefined();
  expect(readInputImage).toHaveBeenCalledWith('s', { sequence: 1, imageIndex: 2 });
});

it('does not revive filename-only images or unsupported resource versions', () => {
  const { resourceId: _id, resourceInputVersion: _version, ...legacy } = reference;
  expect(
    imageMetadata([
      { ...legacy, fileName: `${'a'.repeat(64)}.bin` },
      { ...reference, resourceInputVersion: 2 },
      { ...reference, resourceId: '../outside' },
      { ...reference, resourceId: undefined }
    ]).map((image) => image.readable)
  ).toEqual([false, false, false, false]);
});

it('retains MIME, size and hash validation for logical references', () => {
  expect(
    imageMetadata([
      { ...reference, mimeType: 'text/plain' },
      { ...reference, byteSize: 0 },
      { ...reference, byteSize: Number.MAX_SAFE_INTEGER },
      { ...reference, sha256: 'invalid' }
    ]).map((image) => image.readable)
  ).toEqual([false, false, false, false]);
});
