import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const productRoot = resolve(import.meta.dirname, '../../..');
const webRequire = createRequire(resolve(productRoot, 'packages/web-core/package.json'));

export async function startCustomThemeFixture(
  entry?: string,
  options?: {
    protocolSource?: boolean;
    apiProxy?: string;
    aliases?: { find: string; replacement: string }[];
  }
) {
  const [{ createServer }, vue] = await Promise.all([
    import(webRequire.resolve('vite')),
    import(webRequire.resolve('@vitejs/plugin-vue'))
  ]);
  const cacheKey = `${encodeURIComponent(entry ?? 'all')}-${options?.protocolSource ? 'source' : 'dist'}-${randomUUID()}`;
  const server = await createServer({
    root: productRoot,
    cacheDir: resolve(productRoot, `test/runs/theme-vite-${process.pid}-${cacheKey}`),
    configFile: false,
    plugins: [vue.default()],
    optimizeDeps: { entries: [entry ?? 'test/e2e/support/*.html'] },
    resolve: {
      alias: [
        ...(options?.aliases ?? []),
        ...(options?.protocolSource
          ? [
              {
                find: '@myagentroam/protocol',
                replacement: resolve(productRoot, 'packages/protocol/src/index.ts')
              }
            ]
          : []),
        { find: '@', replacement: resolve(productRoot, 'ee/web/src') },
        { find: 'vue', replacement: webRequire.resolve('vue/dist/vue.esm-bundler.js') }
      ]
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      ...(options?.apiProxy === undefined
        ? {}
        : { proxy: { '/api': { target: options.apiProxy, ws: true, changeOrigin: false } } }),
      fs: { allow: [productRoot] },
      watch: null
    },
    logLevel: 'error'
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) {
    await server.close();
    throw new Error('Theme fixture URL unavailable');
  }
  return {
    url: `${url}test/e2e/support/`,
    close: () => server.close()
  };
}
