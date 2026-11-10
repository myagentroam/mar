import { afterEach, expect, it, vi } from 'vitest';
import {
  NodeUpgradeCoordinator,
  upgradeMetadata
} from '../../src/service/node-upgrade-coordinator.js';

afterEach(() => vi.unstubAllEnvs());

it('does not advertise or accept independent upgrades for a Quick Start Node', () => {
  vi.stubEnv('MAR_QUICK_START_OWNER', '1');
  vi.stubEnv('MAR_NODE_SUPERVISED', '0');
  const coordinator = new NodeUpgradeCoordinator(
    () => '/unused',
    () => 1,
    vi.fn(),
    vi.fn()
  );
  expect(
    upgradeMetadata({ supervisedUpgrade: true }, coordinator.snapshot(), false)
  ).not.toHaveProperty('supervisedUpgrade');
  expect(() => coordinator.request({ targetVersion: '1.2.3' })).toThrow('NODE_UPGRADE_UNAVAILABLE');
  expect(coordinator.snapshot().state).toBe('IDLE');
});

it('preserves the normal standalone Supervisor upgrade capability', () => {
  vi.stubEnv('MAR_QUICK_START_OWNER', '0');
  vi.stubEnv('MAR_NODE_SUPERVISED', '1');
  const coordinator = new NodeUpgradeCoordinator(
    () => '/unused',
    () => 1,
    vi.fn(),
    vi.fn()
  );
  expect(upgradeMetadata({}, coordinator.snapshot(), false).supervisedUpgrade).toBe(true);
  expect(coordinator.request({ targetVersion: '1.2.3' }).status).toBe('ACCEPTED');
  coordinator.stop();
});
