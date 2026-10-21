import { describe, expect, it } from 'vitest';
import { normalizeWorkspaceGroupName } from '../../src/workspace-group.js';

describe('Workspace group names', () => {
  it('trims names and represents an explicit clear as null', () => {
    expect(normalizeWorkspaceGroupName('  Engineering  ')).toBe('Engineering');
    expect(normalizeWorkspaceGroupName(null)).toBeNull();
  });

  it.each(['', '   ', 'x'.repeat(129)])('rejects invalid group names', (value) => {
    expect(() => normalizeWorkspaceGroupName(value)).toThrow('WORKSPACE_GROUP_NAME_INVALID');
  });
});
