import {
  buildHostedConversationFileTree,
  visibleHostedConversationFileTreeRows
} from '../../src/service/hosted-conversation-file-tree-service.js';

import { describe, expect, it } from 'vitest';
type ConversationFileProjection = Parameters<typeof buildHostedConversationFileTree>[0][number];

describe('Hosted conversation file tree', () => {
  it('Merge related files into a directory tree by relative path and collapse directories by default', () => {
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
    expect(
      visibleHostedConversationFileTreeRows(tree, () => false).map((row) => [
        row.node.kind,
        row.node.path,
        row.depth
      ])
    ).toEqual([
      ['DIRECTORY', 'assets', 0],
      ['DIRECTORY', 'reports', 0],
      ['FILE', 'notes.txt', 0]
    ]);
    expect(
      visibleHostedConversationFileTreeRows(
        tree,
        (path) => path === 'reports' || path === 'reports/2026'
      ).map((row) => [row.node.kind, row.node.path, row.depth])
    ).toEqual([
      ['DIRECTORY', 'assets', 0],
      ['DIRECTORY', 'reports', 0],
      ['DIRECTORY', 'reports/2026', 1],
      ['FILE', 'reports/2026/q1.txt', 2],
      ['FILE', 'reports/2026/q2.txt', 2],
      ['FILE', 'reports/summary.txt', 1],
      ['FILE', 'notes.txt', 0]
    ]);
  });
});
