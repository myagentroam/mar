import { existsSync } from 'node:fs';
import { LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION } from '@myagentroam/agent/sandbox/linux';
import { describe, expect, it } from 'vitest';
import { probeBubblewrap } from '../../src/service/conversation-hosting-capability-service.js';
import { hostedConversationSandboxProfile } from '../../src/service/hosted-conversation-sandbox-profile.js';

describe('hosted conversation sandbox profile', () => {
  it('compiles Node-owned directories and compatibility aliases into generic mounts', () => {
    expect(
      hostedConversationSandboxProfile({
        workspaceDirectory: '/var/lib/mar/template',
        sourceWorkspacePath: '/home/templates/project',
        inboxDirectory: '/var/lib/mar/conversation/inbox',
        outputDirectory: '/var/lib/mar/conversation/output',
        generatedImagesDirectory: '/var/lib/mar/session/generated_images',
        generatedImagesLogicalPath:
          '/home/mar/.mar/agent/sessions/session-current/generated_images',
        temporaryDirectory: '/var/tmp/mar-conversation',
        networkMode: 'NONE'
      })
    ).toEqual({
      policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
      networkMode: 'NONE',
      mounts: [
        {
          source: '/var/lib/mar/template',
          destination: '/workspace',
          access: 'READ_ONLY'
        },
        {
          source: '/var/lib/mar/template',
          destination: '/home/templates/project',
          access: 'READ_ONLY'
        },
        {
          source: '/var/lib/mar/conversation/inbox',
          destination: '/home/templates/project/inbox',
          access: 'READ_WRITE'
        },
        {
          source: '/var/lib/mar/conversation/output',
          destination: '/home/templates/project/output',
          access: 'READ_WRITE'
        },
        {
          source: '/var/lib/mar/session/generated_images',
          destination: '/home/mar/.mar/agent/sessions/session-current/generated_images',
          access: 'READ_ONLY'
        },
        {
          source: '/var/lib/mar/conversation/inbox',
          destination: '/workspace/inbox',
          access: 'READ_WRITE'
        },
        {
          source: '/var/lib/mar/conversation/output',
          destination: '/workspace/output',
          access: 'READ_WRITE'
        }
      ],
      temporaryDirectory: {
        kind: 'MOUNT',
        source: '/var/tmp/mar-conversation'
      },
      workingDirectory: { kind: 'REQUEST' }
    });
  });

  it('omits optional aliases and rejects an incomplete generated-image mount', () => {
    expect(
      hostedConversationSandboxProfile({
        workspaceDirectory: '/var/lib/mar/template',
        inboxDirectory: '/var/lib/mar/conversation/inbox',
        outputDirectory: '/var/lib/mar/conversation/output',
        temporaryDirectory: '/var/tmp/mar-conversation',
        networkMode: 'UNRESTRICTED'
      })
    ).toMatchObject({
      networkMode: 'UNRESTRICTED',
      mounts: [
        { destination: '/workspace', access: 'READ_ONLY' },
        { destination: '/workspace/inbox', access: 'READ_WRITE' },
        { destination: '/workspace/output', access: 'READ_WRITE' }
      ]
    });

    expect(() =>
      hostedConversationSandboxProfile({
        workspaceDirectory: '/var/lib/mar/template',
        inboxDirectory: '/var/lib/mar/conversation/inbox',
        outputDirectory: '/var/lib/mar/conversation/output',
        generatedImagesDirectory: '/var/lib/mar/session/generated_images',
        temporaryDirectory: '/var/tmp/mar-conversation',
        networkMode: 'NONE'
      })
    ).toThrow('SANDBOX_POLICY_INVALID');
  });

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/bwrap'))(
    'probes the same hosted mount, overlay, persistent tmp and request cwd policy',
    async () => {
      await expect(probeBubblewrap()).resolves.toMatchObject({
        available: true,
        version: expect.any(String)
      });
    }
  );
});
