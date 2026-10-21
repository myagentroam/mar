import { describe, expect, it } from 'vitest';
import {
  ExtensionServices,
  type CoreServiceKey
} from '../../src/agent-core/extensions/services.js';
import { ExtensionResourceScope } from '../../src/agent-core/extensions/resources.js';

const key: CoreServiceKey<(value: number) => number> = { id: 'transform', scope: 'agent' };

describe('Extension typed services', () => {
  it('provides, replaces and wraps without top-level self lookup', async () => {
    const services = new ExtensionServices('agent');
    const a = new ExtensionResourceScope();
    const b = new ExtensionResourceScope();
    const c = new ExtensionResourceScope();
    const base = services.bind(a);
    base.provide(key, (value) => value + 1);
    services.bind(b).replace(key, (value) => value + 2);
    services.bind(c).wrap(key, (below) => (value) => below(value) * 2);
    expect(base.consume(key)?.(1)).toBe(6);
    await c.dispose();
    expect(base.consume(key)?.(1)).toBe(3);
    await b.dispose();
    expect(base.consume(key)?.(1)).toBe(2);
    await a.dispose();
  });

  it('rejects implicit collisions, missing required dependencies and wrong scope', async () => {
    const services = new ExtensionServices('agent');
    const scope = new ExtensionResourceScope();
    const bound = services.bind(scope);
    expect(bound.consume(key, { optional: true })).toBeUndefined();
    expect(() => bound.consume(key)).toThrow(/DEPENDENCY/);
    bound.provide(key, (value) => value);
    expect(() => bound.provide(key, (value) => value)).toThrow(/CONFLICT/);
    expect(() => bound.provide({ ...key, scope: 'session' }, (value) => value)).toThrow(/SCOPE/);
    await scope.dispose();
  });

  it('lets Session consumers use Agent providers without publishing into Agent scope', async () => {
    const agent = new ExtensionServices('agent');
    const session = new ExtensionServices('session', agent);
    const a = new ExtensionResourceScope();
    const s = new ExtensionResourceScope();
    agent.bind(a).provide(key, (value) => value + 1);
    expect(session.bind(s).consume(key)?.(1)).toBe(2);
    expect(() => session.bind(s).replace(key, (value) => value)).toThrow(/SCOPE/);
    await s.dispose();
    await a.dispose();
  });
});
