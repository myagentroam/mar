import { describe, expect, it } from 'vitest';
import { filterManagementNodes } from '../../ee/server/src/route/management-routes.js';

describe('Server system Node management routes', () => {
  const nodes = [
    { id: 'own-node', ownerUserId: 1, connected: true, disabled: false },
    { id: 'other-personal-node', ownerUserId: 2, connected: false, disabled: false },
    { id: 'disabled-node', ownerUserId: 3, connected: false, disabled: true }
  ] as const;

  it('Includes all user Nodes by default and filters only by explicit owner and status', () => {
    expect(filterManagementNodes(nodes).map((node) => node.id)).toEqual([
      'own-node',
      'other-personal-node',
      'disabled-node'
    ]);
    expect(filterManagementNodes(nodes, 2).map((node) => node.id)).toEqual(['other-personal-node']);
    expect(filterManagementNodes(nodes, undefined, 'online').map((node) => node.id)).toEqual([
      'own-node'
    ]);
    expect(filterManagementNodes(nodes, undefined, 'disabled').map((node) => node.id)).toEqual([
      'disabled-node'
    ]);
  });
});
