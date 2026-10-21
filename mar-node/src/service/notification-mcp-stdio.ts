import { NODE_MCP, NODE_MCP_VERSION } from '../mcp/naming.js';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { notificationInputSchema } from '@myagentroam/protocol';

const endpoint = process.env['MAR_NOTIFICATION_MCP_ENDPOINT'];
const token = process.env['MAR_NOTIFICATION_MCP_TOKEN'];
if (endpoint === undefined || token === undefined) throw new Error('MAIL_CAPABILITY_INVALID');

const server = new McpServer({ name: NODE_MCP.notification.name, version: NODE_MCP_VERSION });
server.registerTool(
  NODE_MCP.notification.tools.email,
  {
    description:
      'Send a notification email from this MAR-managed Workspace conversation. To email the initiating user’s own account, omit recipientEmail; the Server uses that account’s saved email address and fails if no valid address is configured. Specify recipientEmail only to send to another explicitly authorized address. The Agent works with files and tools on the authorized MAR Node; the MAR Server sends email using its administrator-configured SMTP account. This is not the browser or Node local email account, nor a repository cron/CI notification. This tool cannot access SMTP credentials. Omit the template to use the built-in notification template in the sender’s preferred language; optionally select notification-en-US or notification-zh-CN. Each call may send a real email; do not retry after an uncertain result.',
    inputSchema: {
      templateId: z
        .string()
        .max(64)
        .optional()
        .describe(
          'Optional built-in NOTIFICATION template ID; omitted or empty uses the sender’s preferred language.'
        ),
      title: z
        .string()
        .max(160)
        .regex(/^[^\r\n]*$/u)
        .optional()
        .describe('Optional notification title rendered into the email subject.'),
      recipientEmail: z
        .string()
        .min(3)
        .max(320)
        .optional()
        .describe(
          'Optional authorized recipient override. Omit to email the initiating user’s own account.'
        ),
      message: z.string().min(1).max(4000).describe('Notification text for {{message}}.')
    }
  },
  async (args) => {
    const value = await request({ ...args, callId: randomUUID() });
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  }
);
if (process.env['MAR_NOTIFICATION_MCP_CHANNELS'] === '1') {
  server.registerTool(
    NODE_MCP.notification.tools.send,
    {
      description:
        'Send a real notification from the current authorized Workspace execution. Defaults to push to the initiating user. To email the user’s own account, include email in channels and omit recipientEmail; the Server uses the initiating account’s saved email address and fails if no valid address is configured. Specify recipientEmail only to send to another explicitly authorized address. Channels and registered Push clients are independent. Push may be suppressed while any workbench connection is open or unavailable due to system, browser, or OS settings. Acceptance is not delivery. Do not disclose secrets or send to unauthorized recipients. Each invocation is a new side effect; do not retry after an uncertain or partial result.',
      inputSchema: {
        channels: z
          .array(z.enum(['push', 'email']))
          .min(1)
          .max(2)
          .optional(),
        title: z
          .string()
          .max(160)
          .regex(/^[^\r\n]*$/u)
          .optional(),
        message: z.string().min(1).max(4000),
        recipientEmail: z
          .string()
          .min(3)
          .max(320)
          .optional()
          .describe(
            'Optional authorized recipient override for the email channel. Omit to email the initiating user’s own account.'
          ),
        templateId: z.enum(['', 'notification-en-US', 'notification-zh-CN']).optional()
      }
    },
    async (args) => {
      const input = notificationInputSchema.parse(args);
      const value = await request(
        { ...input, callId: randomUUID() },
        NODE_MCP.notification.tools.send
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    }
  );
}
await server.connect(new StdioServerTransport());

function request(
  args: unknown,
  tool: string = NODE_MCP.notification.tools.email
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint!);
    socket.setTimeout(35_000, () => socket.destroy(new Error('MAIL_DELIVERY_UNCERTAIN')));
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ token, tool, arguments: args })}\n`)
    );
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16_000) socket.destroy(new Error('MAIL_RESPONSE_INVALID'));
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        if (body.length === 0) throw new Error('MAIL_DELIVERY_UNCERTAIN');
        const payload = JSON.parse(body) as { readonly result?: unknown; readonly error?: string };
        if (payload.error !== undefined) reject(new Error(payload.error));
        else resolve(payload.result);
      } catch (error) {
        reject(
          error instanceof Error && error.message === 'MAIL_DELIVERY_UNCERTAIN'
            ? error
            : new Error('MAIL_RESPONSE_INVALID')
        );
      }
    });
  });
}
