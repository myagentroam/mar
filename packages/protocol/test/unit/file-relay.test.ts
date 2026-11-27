import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  decodeByteFrame,
  decodeFileRelayFrame,
  encodeFileRelayEnvelope,
  encodeFileRelayFrame,
  FILE_RELAY_CHUNK_BYTES,
  isFileRelayOperation,
  nodeEnvelopeSchema,
  restoreFileRelayBody
} from '../../src/index.js';

describe('binary file relay', () => {
  it('keeps a full chunk outside metadata and keeps the Terminal payload bound unchanged', () => {
    const bytes = new Uint8Array(FILE_RELAY_CHUNK_BYTES).fill(0xff);
    const operation = 'workspace.file.content.read';
    const response = createEnvelope('node.response', { result: { file: { offset: 0, bytes } } });
    const wire = encodeFileRelayEnvelope(response, operation);
    const { metadata, payload } = decodeFileRelayFrame(wire);
    expect(metadata.type).toBe('file.response');
    expect(metadata.byteLength).toBe(bytes.length);
    expect(metadata.envelope).toMatchObject({ payload: { result: { file: { offset: 0 } } } });
    expect(JSON.stringify(metadata)).not.toContain('255');
    expect(Buffer.compare(payload, bytes)).toBe(0);
    expect(() => decodeByteFrame(wire)).toThrow('BYTE_FRAME_LIMIT');
    expect(() => encodeFileRelayFrame({}, new Uint8Array(bytes.length + 1))).toThrow(
      'BYTE_FRAME_LIMIT'
    );
  });

  it('distinguishes an empty download from a missing or mismatched binary body', () => {
    const operation = 'workspace.git.commit.file.content.read';
    const response = createEnvelope('node.response', {
      result: { file: { size: 0, offset: 0, bytes: new Uint8Array() } }
    });
    const { metadata, payload } = decodeFileRelayFrame(
      encodeFileRelayEnvelope(response, operation)
    );
    const envelope = nodeEnvelopeSchema.parse(metadata.envelope);
    expect(() => restoreFileRelayBody(envelope, operation, payload, undefined)).toThrow(
      'MESSAGE_INVALID'
    );
    expect(() => restoreFileRelayBody(envelope, operation, payload, 1)).toThrow('MESSAGE_INVALID');
    restoreFileRelayBody(envelope, operation, payload, metadata.byteLength);
    expect(envelope.payload).toEqual({
      result: { file: { size: 0, offset: 0, bytes: new Uint8Array() } }
    });
    expect(() => restoreFileRelayBody(envelope, operation, payload, 0)).toThrow('MESSAGE_INVALID');
    expect(() => decodeFileRelayFrame(JSON.stringify(metadata))).toThrow('BYTE_FRAME_INVALID');
  });

  it('keeps Browser file authorization and other non-chunk operations on control', () => {
    const command = (action: string) => ({ payload: { command: { action } } });
    expect(isFileRelayOperation('browser.upload', command('stream'))).toBe(false);
    expect(isFileRelayOperation('browser.upload', command('finish'))).toBe(false);
    expect(isFileRelayOperation('browser.download', command('stream'))).toBe(false);
    expect(isFileRelayOperation('browser.download', command('workspace'))).toBe(false);
    expect(isFileRelayOperation('workspace.file.content.read', { preview: {} })).toBe(false);
    expect(isFileRelayOperation('conversation.hosted.files.upload.complete', {})).toBe(false);
  });
});
