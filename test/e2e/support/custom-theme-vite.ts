import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const productRoot = resolve(import.meta.dirname, '../../..');
const webRequire = createRequire(resolve(productRoot, 'packages/web-core/package.json'));

export async function startCustomThemeFixture(
  entry?: string,
  options?: { protocolSource?: boolean }
) {
  const [{ createServer }, vue, components, resolvers] = await Promise.all([
    import(webRequire.resolve('vite')),
    import(webRequire.resolve('@vitejs/plugin-vue')),
    import(webRequire.resolve('unplugin-vue-components/vite')),
    import(webRequire.resolve('unplugin-vue-components/resolvers'))
  ]);
  const cacheKey = `${encodeURIComponent(entry ?? 'all')}-${options?.protocolSource ? 'source' : 'dist'}`;
  const server = await createServer({
    root: productRoot,
    cacheDir: resolve(productRoot, `test/runs/theme-vite-${process.pid}-${cacheKey}`),
    configFile: false,
    plugins: [
      vue.default(),
      components.default({ dirs: [], dts: false, resolvers: [resolvers.ElementPlusResolver()] })
    ],
    optimizeDeps: { entries: [entry ?? 'test/e2e/support/*.html'] },
    resolve: {
      alias: [
        ...(options?.protocolSource
          ? [
              {
                find: '@myagentroam/protocol',
                replacement: resolve(productRoot, 'packages/protocol/src/index.ts')
              }
            ]
          : []),
        { find: '@', replacement: resolve(productRoot, 'ee/web/src') },
        { find: 'vue', replacement: webRequire.resolve('vue/dist/vue.esm-bundler.js') },
        {
          find: /^element-plus\/(.*\/style\/css)$/,
          replacement: `${dirname(webRequire.resolve('element-plus/package.json'))}/$1.mjs`
        },
        {
          find: 'element-plus',
          replacement: dirname(webRequire.resolve('element-plus/package.json'))
        },
        {
          find: '@element-plus/icons-vue',
          replacement: resolve(
            dirname(webRequire.resolve('@element-plus/icons-vue/package.json')),
            'dist/index.js'
          )
        }
      ]
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [productRoot] },
      watch: { ignored: [resolve(productRoot, 'test/runs/**')] }
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
