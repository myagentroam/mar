import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

const server = new McpServer({ name: 'mar-agent-test', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Echo input.', inputSchema: { value: z.string() } },
  async (input, extra) => {
    if (input.value === 'disconnect') process.exit(1);
    if (input.value === 'protocolError') {
      throw new McpError(ErrorCode.UrlElicitationRequired, 'MCP fixture protocol exception');
    }
    if (input.value === 'wait') {
      const startedFile = process.env['MAR_TEST_MCP_STARTED_FILE'];
      const abortedFile = process.env['MAR_TEST_MCP_ABORTED_FILE'];
      if (startedFile && abortedFile) {
        await writeFile(startedFile, 'started');
        await new Promise((resolve) => {
          if (extra.signal.aborted) {
            resolve();
            return;
          }
          extra.signal.addEventListener('abort', resolve, { once: true });
        });
        await writeFile(abortedFile, 'aborted');
        return { content: [{ type: 'text', text: 'Cancelled.' }] };
      }
    }
    if (process.env['MAR_TEST_MCP_RESULT_CASES'] === '1') {
      const text = { type: 'text', text: 'independent text' };
      const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
      const resource = { type: 'resource_link', uri: 'file:///sample.txt', name: 'sample' };
      const structuredContent = { answer: 42 };
      const diagnostic = 'MCP fixture diagnostic';
      const cases = {
        text: { content: [text] },
        image: { content: [image] },
        mixed: { content: [text, image, resource] },
        explicitSuccess: { isError: false, content: [text, image, resource], structuredContent },
        error: { isError: true, content: [{ type: 'text', text: diagnostic }] },
        longError: {
          isError: true,
          content: [{ type: 'text', text: `${diagnostic} ${'x'.repeat(1_200)}` }]
        },
        annotated: {
          content: [
            {
              ...text,
              annotations: { audience: ['assistant'], priority: 0.5 },
              _meta: { source: 'text' }
            },
            { ...image, annotations: { audience: ['user'] }, _meta: { source: 'image' } }
          ]
        },
        structured: { content: [text], structuredContent },
        structuredMixed: { content: [text, image, resource], structuredContent },
        structuredJson: {
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent
        },
        empty: { content: [] }
      };
      if (Object.hasOwn(cases, input.value)) return cases[input.value];
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...input,
            ...(process.env['MAR_TEST_REPORT_CLI_TOKEN'] === '1'
              ? { cliToken: process.env['MAR_CTL_USER_TOKEN'] }
              : {})
          })
        }
      ]
    };
  }
);
await server.connect(new StdioServerTransport());
