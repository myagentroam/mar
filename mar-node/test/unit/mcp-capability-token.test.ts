import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpCapabilityToken } from '../../src/mcp/capability-token.js';

const schema = z.object({ executionId: z.string(), sessionId: z.string() }).strict();
const claims = { executionId: 'execution-1', sessionId: 'session-1' };
const key = Buffer.alloc(32, 7);

describe('self-contained MCP capability tokens', () => {
  it('verifies signed claims without a registry of issued credentials', () => {
    const issuer = new McpCapabilityToken('mar_goal', schema, key);
    const verifier = new McpCapabilityToken('mar_goal', schema, key);
    expect(verifier.verify(issuer.sign(claims))).toEqual(claims);
  });

  it('isolates purposes and Node instances even when claim shapes match', () => {
    const issuer = new McpCapabilityToken('mar_goal', schema, key);
    const token = issuer.sign(claims);
    expect(new McpCapabilityToken('mar_schedule', schema, key).verify(token)).toBeUndefined();
    expect(new McpCapabilityToken('mar_goal', schema).verify(token)).toBeUndefined();
  });

  it('rejects substituted claims, signatures and versions', () => {
    const codec = new McpCapabilityToken('mar_goal', schema, key);
    const token = codec.sign(claims);
    const [version, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sessionId: 'other' })).toString(
      'base64url'
    );
    expect(codec.verify(`${version}.${forged}.${signature}`)).toBeUndefined();
    expect(codec.verify(`${version}.${payload}.${'A'.repeat(43)}`)).toBeUndefined();
    expect(codec.verify(token.replace(/^v1/u, 'v2'))).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['object', {}],
    ['empty', ''],
    ['opaque', 'opaque-token'],
    ['invalid alphabet', 'v1.!.!'],
    ['short signature', 'v1.e30.A'],
    ['oversized', 'a'.repeat(8193)]
  ] as const)('rejects malformed %s input without throwing', (_label, input) => {
    expect(new McpCapabilityToken('mar_goal', schema, key).verify(input)).toBeUndefined();
  });

  it.each([
    ['non-JSON', 'not json'],
    ['invalid claims', '{"executionId":4,"sessionId":"session-1"}'],
    ['null', 'null']
  ])('rejects invalid signed payload (%s) without exposing its contents', (_label, text) => {
    const codec = new McpCapabilityToken('mar_goal', schema, key);
    const body = `v1.${Buffer.from(text).toString('base64url')}`;
    const signature = createHmac('sha256', key).update(`mar_goal\0${body}`).digest('base64url');
    expect(codec.verify(`${body}.${signature}`)).toBeUndefined();
  });
});
