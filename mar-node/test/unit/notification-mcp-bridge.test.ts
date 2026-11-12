import { connect } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import {
  NotificationMcpBridge,
  resolveNotificationCapability
} from '../../src/service/notification-mcp-bridge.js';

function invoke(endpoint: string, token: string, args: object, tool = 'send_email_notification') {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(endpoint);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({ token, tool, arguments: { ...(tool === 'send_email_notification' ? { recipientEmail: 'recipient@example.test' } : {}), ...args, callId: '8e1668db-88e7-4a28-9ccd-cda8814a4e73' } })}\n`
      )
    );
    socket.on('data', (chunk) => (body += chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('mail notification MCP capability', () => {
  it('exposes negotiated multi-channel tools through real stdio with a fixed initiating user', async () => {
    const email = vi.fn(async () => undefined);
    const channels = vi.fn(
      async (request: import('@myagentroam/protocol').NotificationChannelsRequest) => ({
        callId: request.callId,
        email: { status: 'accepted' as const }
      })
    );
    let active = true;
    const server = new NotificationMcpBridge(
      (capability) => (active ? capability : undefined),
      email,
      {
        supported: () => true,
        send: channels
      }
    );
    let client: Client | undefined;
    try {
      const executionServer = await server.prepare({
        executionId: 'run-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        userId: 7,
        source: 'SCHEDULED'
      });
      expect(executionServer).toMatchObject({
        name: 'mar_notification',
        origin: 'BUILTIN',
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        command: process.execPath,
        allowedToolCallers: {
          send_notification: ['direct', 'programmatic'],
          send_email_notification: ['direct', 'programmatic']
        }
      });
      expect(executionServer.environment!.MAR_NOTIFICATION_MCP_CHANNELS).toBe('1');
      const endpoint = executionServer.environment!.MAR_NOTIFICATION_MCP_ENDPOINT!;
      const token = executionServer.environment!.MAR_NOTIFICATION_MCP_TOKEN!;
      client = new Client({ name: 'notification-test', version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: executionServer.command!,
          args: [...(executionServer.args ?? [])],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string'
              )
            ),
            ...executionServer.environment
          }
        })
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('send_notification');
      const notification = tools.tools.find((tool) => tool.name === 'send_notification')!;
      const recipientSchema = notification.inputSchema.properties?.['recipientEmail'];
      expect(recipientSchema).toMatchObject({
        type: 'string',
        minLength: 3,
        maxLength: 320
      });
      expect(recipientSchema).not.toHaveProperty('pattern');
      expect(notification.inputSchema.required).not.toContain('recipientEmail');
      await client.callTool({ name: 'send_notification', arguments: { message: 'Done' } });
      expect(channels).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channels: ['push'],
          userId: 7,
          source: 'SCHEDULED',
          eventType: 'notification',
          kind: 'AGENT_MESSAGE'
        })
      );
      await client.callTool({
        name: 'send_notification',
        arguments: {
          channels: ['push', 'email'],
          recipientEmail: 'approved@example.test',
          message: 'Done'
        }
      });
      expect(channels).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channels: ['push', 'email'],
          recipientEmail: 'approved@example.test',
          userId: 7
        })
      );
      expect(email).not.toHaveBeenCalled();
      for (const channelsInput of [['email'], ['push', 'email']]) {
        const result = await client.callTool({
          name: 'send_notification',
          arguments: { channels: channelsInput, message: 'Email my account' }
        });
        expect(result.isError).not.toBe(true);
        expect(channels).toHaveBeenLastCalledWith(
          expect.objectContaining({ channels: channelsInput, userId: 7, source: 'SCHEDULED' })
        );
        expect(channels.mock.lastCall![0]).not.toHaveProperty('recipientEmail');
      }
      for (const recipientEmail of [
        '',
        'invalid',
        'a..b@example.test',
        '.a@example.test',
        'a'.repeat(321)
      ]) {
        const invalid = await client.callTool({
          name: 'send_notification',
          arguments: { channels: ['email'], recipientEmail, message: 'Bad email' }
        });
        expect(invalid.isError).toBe(true);
      }
      for (const args of [
        { channels: ['push'], recipientEmail: 'approved@example.test', message: 'Unexpected email' }
      ]) {
        const invalid = await client.callTool({ name: 'send_notification', arguments: args });
        expect(invalid.isError).toBe(true);
      }
      expect(channels).toHaveBeenCalledTimes(4);
      expect(email).not.toHaveBeenCalled();
      expect(
        await invoke(endpoint, token, { userId: 99, message: 'Bad' }, 'send_notification')
      ).toEqual({ error: 'NOTIFICATION_INPUT_INVALID' });
      active = false;
      const late = await client.callTool({
        name: 'send_notification',
        arguments: { message: 'Too late' }
      });
      expect(late.isError).toBe(true);
    } finally {
      await client?.close();
      await server.close();
    }
  });

  it('does not enable multi-channel calls when the Server has not negotiated support', async () => {
    const server = new NotificationMcpBridge(
      (capability) => capability,
      async () => undefined
    );
    try {
      const executionServer = await server.prepare({
        executionId: 'run-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        userId: 7,
        source: 'MANUAL'
      });
      expect(executionServer.environment!.MAR_NOTIFICATION_MCP_CHANNELS).toBe('0');
      expect(
        await invoke(
          executionServer.environment!.MAR_NOTIFICATION_MCP_ENDPOINT!,
          executionServer.environment!.MAR_NOTIFICATION_MCP_TOKEN!,
          { message: 'Done' },
          'send_notification'
        )
      ).toEqual({ error: 'NOTIFICATION_UNSUPPORTED' });
    } finally {
      await server.close();
    }
  });
  it.each(['MANUAL', 'SCHEDULED'] as const)(
    'binds %s calls to the current execution, user and Workspace, then revokes them',
    async (source) => {
      let active = true;
      const send = vi.fn(async () => undefined);
      const server = new NotificationMcpBridge(
        (capability) => (active ? capability : undefined),
        send
      );
      try {
        const executionServer = await server.prepare({
          executionId: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          userId: 7,
          source
        });
        const endpoint = executionServer.environment!.MAR_NOTIFICATION_MCP_ENDPOINT!;
        const token = executionServer.environment!.MAR_NOTIFICATION_MCP_TOKEN!;
        expect(
          await invoke(endpoint, token, {
            templateId: 'notification-en-US',
            title: 'Build completed',
            message: 'Done'
          })
        ).toEqual({ result: { accepted: true } });
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 7,
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            executionId: 'run-1',
            source,
            recipientEmail: 'recipient@example.test',
            title: 'Build completed',
            message: 'Done'
          })
        );
        active = false;
        expect(
          await invoke(endpoint, token, { templateId: 'notification-en-US', message: 'Again' })
        ).toEqual({
          error: 'MAIL_CAPABILITY_STALE'
        });
        expect(
          await invoke(endpoint, 'invalid', {
            templateId: 'notification-en-US',
            message: 'Again'
          })
        ).toEqual({
          error: 'MAIL_CAPABILITY_INVALID'
        });
      } finally {
        await server.close();
      }
    }
  );

  it('keeps the current execution valid after bootstrap Session promotion and sends the native ID', async () => {
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) =>
        id === 'workspace-1'
          ? { id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null }
          : undefined
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      cwd: '/workspace'
    });
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'Notify me',
      initiatedByUserId: 7
    }).run;
    const execution = runtime.createExecution(run.id);
    const send = vi.fn(async () => undefined);
    const server = new NotificationMcpBridge(
      (capability) => resolveNotificationCapability(runtime, capability),
      send
    );
    try {
      const executionServer = await server.prepare({
        executionId: execution.id,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        userId: 7,
        source: 'MANUAL'
      });
      const endpoint = executionServer.environment!.MAR_NOTIFICATION_MCP_ENDPOINT!;
      const token = executionServer.environment!.MAR_NOTIFICATION_MCP_TOKEN!;
      runtime.promoteSessionIdentity(session.id, 'native-session-1');
      expect(
        await invoke(endpoint, token, { templateId: 'notification-en-US', message: 'Done' })
      ).toEqual({ result: { accepted: true } });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: execution.id,
          sessionId: 'native-session-1',
          workspaceId: 'workspace-1',
          userId: 7,
          recipientEmail: 'recipient@example.test'
        })
      );
      runtime.finishRun(run.id, 'SUCCEEDED');
      expect(
        await invoke(endpoint, token, { templateId: 'notification-en-US', message: 'Late' })
      ).toEqual({ error: 'MAIL_CAPABILITY_STALE' });
    } finally {
      await server.close();
    }
  });

  it('waits for the notification result when sending takes longer than the IPC request', async () => {
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const server = new NotificationMcpBridge((capability) => capability, send);
    try {
      const executionServer = await server.prepare({
        executionId: 'execution-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        userId: 7,
        source: 'MANUAL'
      });
      expect(
        await invoke(
          executionServer.environment!.MAR_NOTIFICATION_MCP_ENDPOINT!,
          executionServer.environment!.MAR_NOTIFICATION_MCP_TOKEN!,
          { message: 'Done' }
        )
      ).toEqual({ result: { accepted: true } });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ templateId: '' }));
      expect(
        await invoke(
          executionServer.environment!.MAR_NOTIFICATION_MCP_ENDPOINT!,
          executionServer.environment!.MAR_NOTIFICATION_MCP_TOKEN!,
          { templateId: '', message: 'Again' }
        )
      ).toEqual({ result: { accepted: true } });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: '', message: 'Again' })
      );
    } finally {
      await server.close();
    }
  });

  it('exposes optional template and recipient fields through real stdio and waits for delivery', async () => {
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const server = new NotificationMcpBridge((capability) => capability, send);
    let client: Client | undefined;
    try {
      const executionServer = await server.prepare({
        executionId: 'execution-2',
        sessionId: 'session-2',
        workspaceId: 'workspace-1',
        userId: 7,
        source: 'MANUAL'
      });
      const transport = new StdioClientTransport({
        command: executionServer.command!,
        args: [...(executionServer.args ?? [])],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          ),
          ...executionServer.environment
        }
      });
      client = new Client({ name: 'mail-notification-test', version: '1.0.0' });
      await client.connect(transport);
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'send_email_notification');
      expect(tool?.inputSchema.required).not.toContain('templateId');
      expect(tool?.inputSchema.required).not.toContain('recipientEmail');
      const result = await client.callTool({
        name: 'send_email_notification',
        arguments: {
          recipientEmail: 'recipient@example.test',
          title: 'Build completed',
          message: 'Delivered'
        }
      });
      expect(result).toMatchObject({
        content: [{ type: 'text', text: '{"accepted":true}' }]
      });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: '',
          title: 'Build completed',
          recipientEmail: 'recipient@example.test',
          message: 'Delivered'
        })
      );
      const accountResult = await client.callTool({
        name: 'send_email_notification',
        arguments: { message: 'Email my account' }
      });
      expect(accountResult).toEqual(result);
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: 7, templateId: '', message: 'Email my account' })
      );
      expect(send).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ recipientEmail: expect.anything() })
      );
    } finally {
      await client?.close();
      await server.close();
    }
  });
});
