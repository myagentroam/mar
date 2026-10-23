import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import config from '../../vitest.config.mjs';

const fixtureResolver = (config.plugins as Plugin[]).find(
  (plugin) => plugin.name === 'component-fixture-templates'
)?.resolveId;

async function resolveComponent(importer: string, source = './Child.vue') {
  if (typeof fixtureResolver !== 'function') throw new Error('Missing component fixture resolver');
  const resolve = vi.fn().mockResolvedValue({ id: '/resolved/Child.vue' });
  const result = await Reflect.apply(fixtureResolver, { resolve }, [source, importer, {}]);
  return { resolve, result };
}

describe('Component fixture compilation isolation', () => {
  it.each([
    '/src/unit-render-page.vue',
    '/src/Parent.vue?label=unit-render',
    '/src/Parent.vue?unit-rendering'
  ])('keeps ordinary component imports unchanged for %s', async (importer) => {
    const { resolve, result } = await resolveComponent(importer);
    expect(result).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['/src/Parent.vue?unit-render', '/src/Parent.vue?vue&type=script&unit-render'])(
    'propagates the explicit fixture marker from %s',
    async (importer) => {
      const { resolve, result } = await resolveComponent(importer);
      expect(resolve).toHaveBeenCalledWith('./Child.vue?unit-render', importer, { skipSelf: true });
      expect(result).toEqual({ id: '/resolved/Child.vue' });
    }
  );

  it.each(['./Child.vue?unit-render', './Child.vue?vue&type=style', './helper.ts'])(
    'does not rewrite an already marked or non-template request %s',
    async (source) => {
      const { resolve, result } = await resolveComponent('/src/Parent.vue?unit-render', source);
      expect(result).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    }
  );
});
