import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

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
  const messageLibraryStub = '\0prompt-completion-element-plus-stub';
  const elementPlusMessageStub: Plugin = {
    name: 'prompt-completion-element-plus-stub',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'element-plus') return messageLibraryStub;
      if (source.startsWith('element-plus/'))
        return resolve(
          dirname(webCoreRequire.resolve('element-plus/package.json')),
          source.slice('element-plus/'.length)
        );
      return undefined;
    },
    load(id) {
      return id === messageLibraryStub
        ? `export { ElButton } from 'element-plus/es/components/button/index.mjs';\nexport const ElMessage = { info() {}, error() {}, warning() {} };\nexport const ElMessageBox = { confirm: async () => undefined };`
        : undefined;
    }
  };
  const server: ViteDevServer = await createServer({
    root: fixtureRoot,
    configFile: false,
    plugins: [vuePlugin.default(), elementPlusMessageStub],
    resolve: {
      alias: {
        vue: webCoreRequire.resolve('vue/dist/vue.esm-bundler.js'),
        '@element-plus/icons-vue': resolve(
          dirname(webCoreRequire.resolve('@element-plus/icons-vue/package.json')),
          'dist/index.js'
        )
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
  return { url, close: () => server.close() };
}
