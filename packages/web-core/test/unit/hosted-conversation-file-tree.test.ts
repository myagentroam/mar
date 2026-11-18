import { buildHostedConversationFileTree } from '../../src/service/hosted-conversation-file-tree-service.js';

import { describe, expect, it } from 'vitest';
type ConversationFileProjection = Parameters<typeof buildHostedConversationFileTree>[0][number];

describe('Hosted conversation file tree', () => {
  it('groups related files by relative path with directories first and sorted children', () => {
    const file = (id: string, relativePath: string): ConversationFileProjection => ({
      id,
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath,
      displayName: relativePath.split('/').at(-1) ?? relativePath,
      mimeType: 'text/plain',
      size: 1,
      source: 'AGENT',
      createdAt: 1,
      updatedAt: 1
    });
    const tree = buildHostedConversationFileTree([
      file('q2', 'reports/2026/q2.txt'),
      file('root', 'notes.txt'),
      file('logo', 'assets/logo.png'),
      file('summary', 'reports/summary.txt'),
      file('q1', 'reports/2026/q1.txt')
    ]);

    expect(tree.map((node) => [node.kind, node.path])).toEqual([
      ['DIRECTORY', 'assets'],
      ['DIRECTORY', 'reports'],
      ['FILE', 'notes.txt']
    ]);
    expect(tree[1]).toMatchObject({
      children: [
        {
          kind: 'DIRECTORY',
          path: 'reports/2026',
          children: [
            { kind: 'FILE', path: 'reports/2026/q1.txt' },
            { kind: 'FILE', path: 'reports/2026/q2.txt' }
          ]
        },
        { kind: 'FILE', path: 'reports/summary.txt' }
      ]
    });
  });
});
