import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeJsonlRecord, encodeJsonlRecord } from '../../src/session/store/jsonl/jsonl-codec.js';

const resourceId = 'a'.repeat(64);
const sha256 = 'b'.repeat(64);
const record = {
  recordId: 'record-1',
  sequence: 1,
  timestamp: '2026-10-27T00:00:00.000Z',
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  executionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  turnId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  type: 'turn.user',
  payload: { prompt: 'hello' }
};

describe('JSONL record codec', () => {
  it('decodes fixed v1 records to logical records and writes equivalent v2 lines', async () => {
    const fixture = fileURLToPath(new URL('../fixtures/jsonl-v1/records.jsonl', import.meta.url));
    const lines = (await readFile(fixture, 'utf8')).trimEnd().split('\n');
    const records = lines.map((line) => decodeJsonlRecord(line, 1));
    expect(
      records.map(({ recordId, sequence, sessionId, type }) => ({
        recordId,
        sequence,
        sessionId,
        type
      }))
    ).toEqual([
      {
        recordId: '11111111-1111-4111-8111-111111111111',
        sequence: 1,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: 'turn.user'
      },
      {
        recordId: '22222222-2222-4222-8222-222222222222',
        sequence: 2,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: 'model.context'
      },
      {
        recordId: '33333333-3333-4333-8333-333333333333',
        sequence: 3,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: 'compact.completed'
      }
    ]);
    expect(records[0]).toMatchObject({
      executionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      payload: {
        images: [
          {
            name: 'photo.png',
            resourceId,
            sha256,
            url: 'https://example.test/image',
            urlExpiresAt: 123456789
          }
        ]
      }
    });
    const input = records[0]!.payload as { images: Array<Record<string, unknown>> };
    expect(input.images[0]).not.toHaveProperty('fileName');
    const checkpoint = records[2]!.payload as {
      pendingInputs: Array<{
        schemaVersion?: number;
        payload: { images: Array<Record<string, unknown>> };
      }>;
    };
    expect(checkpoint.pendingInputs[0]).not.toHaveProperty('schemaVersion');
    expect(checkpoint.pendingInputs[0]!.payload.images[0]).not.toHaveProperty('fileName');
    for (const logical of records) {
      expect(logical).not.toHaveProperty('schemaVersion');
      const encoded = encodeJsonlRecord(logical, 2);
      expect(JSON.parse(encoded)).not.toHaveProperty('schemaVersion');
      expect(decodeJsonlRecord(encoded, 2)).toEqual(logical);
    }
    expect(records[1]!.payload).toMatchObject({ toolInput: { fileName: 'workspace.txt' } });
  });

  it('does not rewrite legacy images, tool arguments, artifacts or arbitrary user payload fields', () => {
    const payload = {
      images: [{ fileName: 'legacy.bin', name: 'legacy' }],
      context: { fileName: 'workspace.txt' }
    };
    expect(
      decodeJsonlRecord(JSON.stringify({ schemaVersion: 1, ...record, payload }), 1).payload
    ).toEqual(payload);
    const artifact = {
      artifacts: [{ kind: 'image', fileName: 'image_call.png' }],
      input: { fileName: 'input.txt' }
    };
    expect(
      decodeJsonlRecord(
        JSON.stringify({ schemaVersion: 1, ...record, type: 'tool.completed', payload: artifact }),
        1
      ).payload
    ).toEqual(artifact);
  });

  it('rejects inconsistent resource identity instead of erasing the evidence', () => {
    const payload = {
      images: [
        {
          resourceInputVersion: 1,
          name: 'x',
          mimeType: 'image/png',
          byteSize: 4,
          resourceId,
          sha256,
          fileName: 'other.bin'
        }
      ]
    };
    expect(() =>
      decodeJsonlRecord(JSON.stringify({ schemaVersion: 1, ...record, payload }), 1)
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_SESSION_CORRUPT' }));
  });

  it('converts extension input images while preserving unrelated nested fields', () => {
    const image = {
      resourceInputVersion: 1,
      name: 'x',
      mimeType: 'image/png',
      byteSize: 4,
      resourceId,
      sha256,
      fileName: `${resourceId}.bin`
    };
    const payload = { images: [image], context: { images: [image], fileName: 'workspace.txt' } };
    const decoded = decodeJsonlRecord(
      JSON.stringify({ schemaVersion: 1, ...record, type: 'extension.input', payload }),
      1
    );
    expect(decoded.payload).toEqual({
      ...payload,
      images: [
        {
          resourceInputVersion: 1,
          name: 'x',
          mimeType: 'image/png',
          byteSize: 4,
          resourceId,
          sha256
        }
      ]
    });
  });

  it.each([1, 2])(
    'rejects an unknown image version in known resource positions for encoding %i',
    (encoding) => {
      const payload = { images: [{ resourceInputVersion: 2, resourceId }] };
      const envelope =
        encoding === 1 ? { schemaVersion: 1, ...record, payload } : { ...record, payload };
      expect(() => decodeJsonlRecord(JSON.stringify(envelope), encoding)).toThrowError(
        expect.objectContaining({ code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED' })
      );
    }
  );

  it('rejects unknown nested pending-record versions without changing unrelated payload versions', () => {
    const pending = { ...record, schemaVersion: 3 };
    const checkpoint = {
      ...record,
      type: 'compact.completed',
      payload: { pendingInputs: [pending] }
    };
    expect(() =>
      decodeJsonlRecord(JSON.stringify({ schemaVersion: 1, ...checkpoint }), 1)
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED' }));
    const userPayload = {
      schemaVersion: 300,
      images: [{ resourceInputVersion: 300, fileName: 'user-file' }]
    };
    expect(
      decodeJsonlRecord(
        JSON.stringify({
          schemaVersion: 1,
          ...record,
          type: 'tool.completed',
          payload: userPayload
        }),
        1
      ).payload
    ).toEqual(userPayload);
  });

  it.each([2, 3, 42])('rejects a complete higher-version v1 envelope %i', (version) => {
    expect(() =>
      decodeJsonlRecord(JSON.stringify({ schemaVersion: version, ...record }), 1)
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED' }));
  });

  it('rejects unknown selected encodings and physical versions in v2 lines', () => {
    expect(() => decodeJsonlRecord(JSON.stringify(record), 3)).toThrowError(
      expect.objectContaining({ code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED' })
    );
    expect(() => encodeJsonlRecord(record, 3)).toThrowError(
      expect.objectContaining({ code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED' })
    );
    expect(() =>
      decodeJsonlRecord(JSON.stringify({ schemaVersion: 2, ...record }), 2)
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED' }));
    expect(() =>
      decodeJsonlRecord(JSON.stringify({ schemaVersion: 1, ...record }), 2)
    ).toThrowError(expect.objectContaining({ code: 'MAR_AGENT_SESSION_CORRUPT' }));
  });

  it.each([
    '{',
    JSON.stringify({ ...record, schemaVersion: 1, sequence: 0 }),
    JSON.stringify({ ...record, schemaVersion: 1, recordId: 7 }),
    JSON.stringify({ ...record, schemaVersion: 1, executionId: null }),
    JSON.stringify({ ...record, schemaVersion: 1, payload: undefined }),
    JSON.stringify(record)
  ])('rejects malformed v1 envelopes without inventing records', (line) => {
    expect(() => decodeJsonlRecord(line, 1)).toThrowError(
      expect.objectContaining({ code: 'MAR_AGENT_SESSION_CORRUPT' })
    );
  });
});
