import { describe, expect, it } from 'vitest';
import {
  ExecutionToolPermissions,
  projectPermissionTool
} from '../../src/agent-core/tools/permissions.js';
import type { ClientToolDefinition } from '../../src/agent-core/tools/contracts.js';
import { structuredToolEventData } from '../../src/agent-core/tools/output-projection.js';

const tool: ClientToolDefinition = {
  name: 'exec',
  description: 'Execute a command.',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
    additionalProperties: false
  }
};

it('preserves permission stops in both foreground and retained Code Mode event data', () => {
  const permissionStop = {
    action: 'ask' as const,
    reason: 'Confirm target.',
    source: {
      sessionId: 's',
      executionId: 'e',
      callId: 'inner',
      toolName: 'exec',
      parentCallId: 'outer'
    }
  };
  for (const name of ['code_exec', 'code_exec_wait'])
    expect(
      structuredToolEventData(name, {
        cellId: 'cell',
        status: 'failed',
        cached: true,
        permissionStop
      })
    ).toMatchObject({ permissionStop });
});
const context = { sessionId: 'session', executionId: 'execution', actor: 'model' as const };

describe('Auto tool permissions', () => {
  it('keeps a nested Code Mode deny local while preserving failed-call identity', () => {
    const policy = new ExecutionToolPermissions('auto', context);
    expect(() =>
      policy.prepare(
        {
          name: 'exec',
          callId: 'inner',
          arguments: {
            command: 'blocked',
            permission: { action: 'deny', reason: 'Explicit prohibition.' }
          }
        },
        { ...context, actor: 'code-mode', parentToolCallId: 'outer' },
        tool
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'MAR_AGENT_PERMISSION_DENIED',
        permissionStop: expect.objectContaining({
          action: 'deny',
          source: expect.objectContaining({ callId: 'inner', parentCallId: 'outer' })
        })
      })
    );
    expect(policy.stop).toBeUndefined();
    expect(() => policy.assertDispatch()).not.toThrow();
    expect(
      policy.prepare({ name: 'exec', arguments: { command: 'git status' } }, context, tool)
        .arguments
    ).toEqual({ command: 'git status' });
  });

  it('projects optional permission and treats omitted/null/allow identically', () => {
    const projected = projectPermissionTool(tool);
    expect(projected.inputSchema.properties).toHaveProperty('permission');
    for (const permission of [
      undefined,
      null,
      { action: 'allow' },
      { action: 'allow', reason: null }
    ]) {
      const policy = new ExecutionToolPermissions('auto', context);
      const call = policy.prepare(
        {
          name: 'exec',
          callId: 'call',
          arguments: { command: 'git status', ...(permission === undefined ? {} : { permission }) }
        },
        context,
        tool
      );
      expect(call.arguments).toEqual({ command: 'git status' });
      expect(policy.stop).toBeUndefined();
    }
  });

  it('stops an ask before effects and blocks later dispatch when no approval handler exists', () => {
    const policy = new ExecutionToolPermissions('auto', context);
    expect(() =>
      policy.prepare(
        {
          name: 'exec',
          callId: 'call',
          arguments: {
            command: 'danger',
            permission: { action: 'ask', reason: 'Requires a bounded target.' }
          }
        },
        context,
        tool
      )
    ).toThrow();
    expect(policy.stop).toEqual({
      action: 'ask',
      reason: 'Requires a bounded target.',
      source: { sessionId: 'session', executionId: 'execution', callId: 'call', toolName: 'exec' }
    });
    expect(() =>
      policy.prepare(
        { name: 'exec', callId: 'next', arguments: { command: 'next' } },
        context,
        tool
      )
    ).toThrow('not executed');
  });

  it('fails a deny call without stopping later dispatch', () => {
    const policy = new ExecutionToolPermissions('auto', context);
    expect(() =>
      policy.prepare(
        {
          name: 'exec',
          callId: 'call',
          arguments: {
            command: 'danger',
            permission: { action: 'deny', reason: 'Explicit prohibition.' }
          }
        },
        context,
        tool
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'MAR_AGENT_PERMISSION_DENIED',
        permissionStop: expect.objectContaining({
          action: 'deny',
          source: expect.objectContaining({ callId: 'call' })
        })
      })
    );
    expect(policy.stop).toBeUndefined();
    expect(
      policy.prepare(
        { name: 'exec', callId: 'next', arguments: { command: 'next' } },
        context,
        tool
      ).arguments
    ).toEqual({ command: 'next' });
  });

  it.each([
    {},
    false,
    'allow',
    { action: 'ask' },
    { action: 'ask', reason: null },
    { action: 'deny', reason: ' ' },
    { action: 'allow', unexpected: true }
  ])('rejects invalid metadata instead of allowing: %j', (permission) => {
    const policy = new ExecutionToolPermissions('auto', context);
    expect(() =>
      policy.prepare({ name: 'exec', arguments: { command: 'cmd', permission } }, context, tool)
    ).toThrow();
    expect(policy.stop).toBeUndefined();
  });

  it('wraps business permission fields, without recursively stripping native input', () => {
    const business = {
      ...tool,
      inputSchema: {
        type: 'object',
        properties: { permission: { type: 'string' } },
        additionalProperties: false
      }
    };
    expect(projectPermissionTool(business).inputSchema.properties).toHaveProperty('input');
    const policy = new ExecutionToolPermissions('auto', context);
    expect(
      policy.prepare(
        { name: 'exec', arguments: { input: { permission: 'reader' }, permission: null } },
        context,
        business
      ).arguments
    ).toEqual({ permission: 'reader' });
    expect(
      policy.prepare(
        { name: 'exec', arguments: { permission: 'reader' }, permission: null },
        { ...context, actor: 'extension' },
        business
      ).arguments
    ).toEqual({ permission: 'reader' });
  });

  it('keeps business fields in Full access and refuses explicit framework asks', () => {
    const policy = new ExecutionToolPermissions('full-access', context);
    expect(
      policy.prepare({ name: 'exec', arguments: { permission: 'reader' } }, context, tool).arguments
    ).toEqual({ permission: 'reader' });
    expect(() =>
      policy.prepare(
        {
          name: 'exec',
          arguments: { command: 'cmd' },
          permission: { action: 'ask', reason: 'Confirm target.' }
        },
        { ...context, actor: 'extension' },
        tool
      )
    ).toThrow();
  });

  it('uses JSON forms for freeform tools and preserves parameterless eligibility', () => {
    expect(projectPermissionTool({ ...tool, inputMode: 'freeform' }).inputMode).toBe('json');
    expect(
      projectPermissionTool({
        ...tool,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      }).parameterless
    ).toBe(true);
  });
});
