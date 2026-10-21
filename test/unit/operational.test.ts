import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  nodeResponseErrorPayloadSchema,
  publicErrorMessage
} from '../../packages/protocol/src/index.js';
import { MarAgentError } from '../../mar-agent/src/index.js';
import { NodeRequestError } from '../../packages/server-core/src/node-request-channel.js';
import { apiErrorFromResponse } from '../../packages/web-core/src/util/api-error.js';
import { platformCliCommand, platformCliInvocation } from '../../mar-node/src/operational.js';
import { RotatingNodeLog } from '../../mar-node/src/rotating-log.js';
import { RotatingLogStream } from '../../ee/server/src/rotating-log-stream.js';
import {
  safeErrorCode as safeNodeErrorCode,
  safePublicError as safeNodePublicError
} from '../../mar-node/src/util/safe-error.js';
import {
  safeErrorCode as safeServerErrorCode,
  safePublicError as safeServerPublicError
} from '../../ee/server/src/util/http-request.js';

describe('Cross-boundary error codes', () => {
  it('preserves a real SDK capacity error through Node wire, Server relay and browser parsing', () => {
    const failure = safeNodePublicError(
      new MarAgentError(
        'service_unavailable_error',
        'Service is too busy. Provider request ID: provider-request-1'
      ),
      'INTERNAL_ERROR'
    );
    const wire = nodeResponseErrorPayloadSchema.parse({
      error: failure.code,
      message: failure.message,
      details: failure.details
    });
    const relayed = safeServerPublicError(new NodeRequestError(wire, 'node-request-1'));
    const browser = apiErrorFromResponse(
      { error: { ...relayed, requestId: 'server-request-1' } },
      502
    );
    expect(browser).toMatchObject({
      code: 'service_unavailable_error',
      message: 'Service is too busy. Provider request ID: provider-request-1',
      requestId: 'server-request-1',
      upstreamRequestId: 'node-request-1'
    });
  });

  it('All stable error codes have readable summaries and bounded diagnostics', () => {
    expect(publicErrorMessage('FILE_NOT_FOUND')).toBe('File was not found.');
    expect(publicErrorMessage('GIT_CHANGE_RESTORE_UNAVAILABLE')).toBe(
      'Git change restore is unavailable.'
    );
    expect(publicErrorMessage('INTERNAL_ERROR')).toBe('An internal error occurred.');
    expect(safeNodeErrorCode(new Error('NODE_OFFLINE'), 'NODE_FAILED')).toBe('NODE_OFFLINE');
    expect(safeNodeErrorCode(new Error('connect ECONNREFUSED 127.0.0.1'), 'NODE_FAILED')).toBe(
      'NODE_FAILED'
    );
    expect(safeServerErrorCode(new Error('WORKSPACE_NOT_FOUND'))).toBe('WORKSPACE_NOT_FOUND');
    expect(safeServerErrorCode(new Error('SQL syntax error near password'))).toBe('INTERNAL_ERROR');
    expect(
      safeNodePublicError(
        new Error('Git exited with status 128 while reading repository references.'),
        'INTERNAL_ERROR'
      )
    ).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      details: 'Git exited with status 128 while reading repository references.'
    });
    expect(
      safeServerPublicError(
        new Error('Git exited with status 128 while reading repository references.')
      )
    ).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      details: 'Git exited with status 128 while reading repository references.'
    });
    expect(
      safeNodePublicError(
        new Error('SQL syntax error near password=secret in /home/admin/database.sql'),
        'INTERNAL_ERROR'
      )
    ).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      details: 'SQL syntax error near password=secret in /home/admin/database.sql'
    });
    const boundedError = {
      code: 'UPSTREAM_FAILED',
      publicDetails:
        '  Upstream rejected the request.\nAuthorization: Bearer secret\nquery=SELECT * FROM users;\ncurrentPassword=secret\n    at request (/home/admin/client.ts:1:1)\nstatus=401  ',
      publicParameters: {
        operation: 'workspace.read',
        token: 'secret',
        accessToken: 'secret',
        currentPassword: 'secret',
        clientSecretValue: 'secret',
        privateKey: 'secret',
        tokenCount: 42,
        endpoint: 'https://user:password@example.test/api',
        attempt: 1
      }
    };
    const expectedBounded = {
      code: 'UPSTREAM_FAILED',
      message: 'Upstream failed.',
      details:
        'Upstream rejected the request.\nAuthorization: Bearer secret\nquery=SELECT * FROM users;\ncurrentPassword=secret\n    at request (/home/admin/client.ts:1:1)\nstatus=401',
      parameters: {
        operation: 'workspace.read',
        token: 'secret',
        accessToken: 'secret',
        currentPassword: 'secret',
        clientSecretValue: 'secret',
        privateKey: 'secret',
        tokenCount: 42,
        endpoint: 'https://user:password@example.test/api',
        attempt: 1
      }
    };
    expect(safeNodePublicError(boundedError, 'INTERNAL_ERROR')).toEqual(expectedBounded);
    expect(safeServerPublicError(boundedError)).toEqual(expectedBounded);

    const constrainedError = {
      code: 'UPSTREAM_FAILED',
      publicDetails: `  ${'x'.repeat(1_001)}  `,
      publicParameters: {
        invalidBoolean: true,
        invalidObject: { nested: true },
        invalidNumber: Number.POSITIVE_INFINITY,
        invalidNull: null,
        invalidNul: 'before\0after',
        [` ${'k'.repeat(128)}`]: 'invalid raw key length',
        overlong: 'y'.repeat(1_001),
        ...Object.fromEntries(Array.from({ length: 35 }, (_, index) => [`item${index}`, index]))
      }
    };
    const expectedParameters = {
      overlong: 'y'.repeat(1_000),
      ...Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`item${index}`, index]))
    };
    const expectedConstrained = {
      code: 'UPSTREAM_FAILED',
      message: 'Upstream failed.',
      details: 'x'.repeat(1_000),
      parameters: expectedParameters
    };
    expect(safeNodePublicError(constrainedError, 'INTERNAL_ERROR')).toEqual(expectedConstrained);
    expect(safeServerPublicError(constrainedError)).toEqual(expectedConstrained);
  });
});

describe('Node runtime environment', () => {
  it('Only Windows uses cmd shims for extensionless npm CLIs', () => {
    expect(platformCliCommand('codex', 'win32')).toBe('codex.cmd');
    expect(platformCliCommand('claude.cmd', 'win32')).toBe('claude.cmd');
    expect(platformCliCommand('codex', 'linux')).toBe('codex');
    expect(platformCliInvocation('codex', ['--version'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex.cmd --version']
    });
  });

  it('Controlled Windows cmd invocation supports scoped npm packages and fixed prefixes with spaces', () => {
    expect(
      platformCliInvocation(
        'npm',
        ['install', '--prefix', 'C:\\Program Data\\MAR', '@myagentroam/node@0.1.7'],
        'win32',
        'cmd.exe'
      )
    ).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'npm.cmd install --prefix "C:\\Program Data\\MAR" @myagentroam/node@0.1.7'
      ]
    });
    expect(() =>
      platformCliInvocation('npm', ['install', 'safe&malicious'], 'win32', 'cmd.exe')
    ).toThrow('NODE_CLI_COMMAND_INVALID');
  });

  it.each([
    {
      name: 'server',
      active: 'server.log',
      create: (directory: string, now: () => number) =>
        new RotatingLogStream(directory, 'server', 8, 7 * 24 * 60 * 60 * 1_000, now, false)
    },
    {
      name: 'node',
      active: 'node.log',
      create: (directory: string, now: () => number) =>
        new RotatingNodeLog(directory, 8, 7 * 24 * 60 * 60 * 1_000, now)
    }
  ])(
    '$name logs rotate by size and delete files older than seven days',
    async ({ active, create }) => {
      const directory = await mkdtemp(join(tmpdir(), 'myagentroam-log-'));
      let timestamp = Date.UTC(2026, 7, 23);
      try {
        const log = create(directory, () => timestamp);
        log.write('12345\n');
        log.write('67890\n');
        expect(await readFile(join(directory, active), 'utf8')).toBe('67890\n');
        const rotated = (await readdir(directory)).find((entry) => entry !== active);
        expect(rotated).toBeDefined();
        await utimes(join(directory, rotated!), new Date(0), new Date(0));

        timestamp += 8 * 24 * 60 * 60 * 1_000;
        create(directory, () => timestamp);
        expect(await readdir(directory)).toEqual([active]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    {
      name: 'server',
      active: 'server.log',
      create: (directory: string, now: () => number) =>
        new RotatingLogStream(directory, 'server', 100, 7 * 24 * 60 * 60 * 1_000, now, false)
    },
    {
      name: 'node',
      active: 'node.log',
      create: (directory: string, now: () => number) =>
        new RotatingNodeLog(directory, 100, 7 * 24 * 60 * 60 * 1_000, now)
    }
  ])('$name logs rotate across calendar days', async ({ active, create }) => {
    const directory = await mkdtemp(join(tmpdir(), 'myagentroam-log-day-'));
    let timestamp = Date.UTC(2026, 7, 23, 23, 59);
    try {
      const log = create(directory, () => timestamp);
      log.write('before\n');
      timestamp += 2 * 60 * 1_000;
      log.write('after\n');

      expect(await readFile(join(directory, active), 'utf8')).toBe('after\n');
      expect((await readdir(directory)).filter((entry) => entry !== active)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
