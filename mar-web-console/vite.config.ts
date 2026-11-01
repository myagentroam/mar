import { thirdPartyNoticesPlugin } from '@myagentroam/web-core/build/third-party-notices';
import { directDownloadServiceWorkerPlugin } from '@myagentroam/web-core/build/direct-download-service-worker';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import { SUPPORTED_LOCALES, localeFromLanguages } from '@myagentroam/web-core/locale-config';
import { pwaBuildMetadata } from './scripts/pwa-build-metadata.js';

const webPackage = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')
) as { readonly version?: unknown };
const webVersion = typeof webPackage.version === 'string' ? webPackage.version : 'unknown';
const webBuildHash = randomBytes(12).toString('hex');

function webVersionManifestPlugin(): Plugin {
  return {
    name: 'myagentroam-web-version-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'web-version.json',
        source: JSON.stringify({ version: webVersion, hash: webBuildHash })
      });
    }
  };
}

function firstDocumentPath(acceptLanguage = ''): string {
  const languages = acceptLanguage
    .split(',')
    .map((value) => value.split(';')[0]!.trim().toLowerCase())
    .filter(Boolean);
  const preferredLocale = localeFromLanguages(languages);
  const locale = SUPPORTED_LOCALES.find((candidate) => candidate.value === preferredLocale)!;
  return `${locale.docsPrefix}/getting-started/overview`;
}

function docsRootRedirectPlugin(): Plugin {
  const redirectRoot: Plugin['configureServer'] = (server) => {
    server.middlewares.use((request, response, next) => {
      const pathname = request.url?.split('?')[0] ?? '';
      if (pathname !== '/docs' && pathname !== '/docs/' && pathname !== '/docs/index.html') {
        next();
        return;
      }
      response.writeHead(302, {
        Location: firstDocumentPath(String(request.headers['accept-language'] ?? ''))
      });
      response.end();
    });
  };
  return {
    name: 'myagentroam-docs-root-redirect',
    configureServer: redirectRoot,
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? '';
        if (pathname === '/docs' || pathname === '/docs/' || pathname === '/docs/index.html') {
          response.writeHead(302, {
            Location: firstDocumentPath(String(request.headers['accept-language'] ?? ''))
          });
          response.end();
          return;
        }
        if (!pathname.startsWith('/docs/') || extname(pathname) !== '') {
          next();
          return;
        }
        const documentPath = resolve(import.meta.dirname, `dist${pathname}.html`);
        const docsOutputRoot = resolve(import.meta.dirname, 'dist/docs');
        if (!documentPath.startsWith(`${docsOutputRoot}/`) || !existsSync(documentPath)) {
          response.statusCode = 404;
          response.end('Not Found');
          return;
        }
        request.url = `${pathname}.html${request.url?.slice(pathname.length) ?? ''}`;
        next();
      });
    }
  };
}

const proxy = (target: string, allowedOrigin: string): Record<string, string | ProxyOptions> => {
  const origin = new URL(target).origin;
  const configure: NonNullable<ProxyOptions['configure']> = (proxyServer) => {
    proxyServer.on('proxyReq', (request) => request.setHeader('origin', allowedOrigin));
    proxyServer.on('proxyReqWs', (request) => request.setHeader('origin', allowedOrigin));
  };
  return {
    '/api/node/connect': { target, changeOrigin: false, ws: true, headers: { origin }, configure },
    '/api': { target, changeOrigin: false, ws: true, headers: { origin }, configure }
  };
};

const serverTarget = process.env.MAR_WEB_CONSOLE_SERVER_URL ?? 'http://127.0.0.1:5090';
const allowedOrigin = process.env.MAR_DEV_WEB_EXTERNAL_ORIGIN ?? new URL(serverTarget).origin;
const docsTarget = `http://127.0.0.1:${process.env.MAR_DOCS_PORT ?? '5092'}`;

export default defineConfig({
  plugins: [
    vue(),
    Components({ dirs: [], dts: false, resolvers: [ElementPlusResolver()] }),
    directDownloadServiceWorkerPlugin(),
    docsRootRedirectPlugin(),
    webVersionManifestPlugin(),
    pwaBuildMetadata('/'),
    thirdPartyNoticesPlugin({ outputDirectory: resolve(import.meta.dirname, 'dist') })
  ],
  build: { sourcemap: false },
  define: {
    __MAR_WEB_VERSION__: JSON.stringify(webVersion),
    __MAR_WEB_BUILD_HASH__: JSON.stringify(webBuildHash)
  },
  resolve: {
    alias: { '@': new URL('../ee/web/src/', import.meta.url).pathname }
  },
  server: {
    host: true,
    port: 5093,
    allowedHosts: (process.env.MAR_DEV_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
    proxy: {
      '/docs/': { target: docsTarget, changeOrigin: true, ws: true },
      ...proxy(serverTarget, allowedOrigin)
    }
  },
  preview: {
    port: 5193,
    proxy: proxy(
      process.env.MAR_WEB_CONSOLE_SERVER_URL ?? 'http://127.0.0.1:5190',
      process.env.MAR_DEV_WEB_EXTERNAL_ORIGIN ?? 'http://127.0.0.1:5190'
    )
  }
});
