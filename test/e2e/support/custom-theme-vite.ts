import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const productRoot = resolve(import.meta.dirname, '../../..');
const webRequire = createRequire(resolve(productRoot, 'packages/web-core/package.json'));

export async function startCustomThemeFixture(entry?: string) {
  const [{ createServer }, vue] = await Promise.all([
    import(webRequire.resolve('vite')),
    import(webRequire.resolve('@vitejs/plugin-vue'))
  ]);
  const server = await createServer({
    root: productRoot,
    configFile: false,
    plugins: [vue.default()],
    ...(entry === undefined ? {} : { optimizeDeps: { entries: [entry] } }),
    resolve: {
      alias: {
        vue: webRequire.resolve('vue/dist/vue.esm-bundler.js'),
        'element-plus': dirname(webRequire.resolve('element-plus/package.json')),
        '@element-plus/icons-vue': resolve(
          dirname(webRequire.resolve('@element-plus/icons-vue/package.json')),
          'dist/index.js'
        )
      }
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [productRoot] } },
    logLevel: 'error'
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) {
    await server.close();
    throw new Error('Theme fixture URL unavailable');
  }
  return { url: `${url}test/e2e/support/`, close: () => server.close() };
}
