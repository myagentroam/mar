import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';

const productRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(productRoot, 'test/e2e/support');
const webCoreRequire = createRequire(resolve(productRoot, 'packages/web-core/package.json'));

export async function startPromptCompletionViteFixture(): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const [{ createServer }, vuePlugin] = await Promise.all([
    import(webCoreRequire.resolve('vite')),
    import(webCoreRequire.resolve('@vitejs/plugin-vue'))
  ]);
  const server: ViteDevServer = await createServer({
    root: fixtureRoot,
    cacheDir: resolve(productRoot, `test/runs/prompt-vite-${process.pid}`),
    configFile: false,
    plugins: [vuePlugin.default()],
    optimizeDeps: { entries: ['index.html', 'composer-reference-browser.html'] },
    resolve: {
      alias: {
        vue: webCoreRequire.resolve('vue/dist/vue.esm-bundler.js')
      }
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [productRoot] }
    },
    appType: 'spa',
    logLevel: 'error'
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) {
    await server.close();
    throw new Error('Prompt completion Vite fixture did not expose a local URL.');
  }
  return {
    url,
    close: () => server.close()
  };
}
