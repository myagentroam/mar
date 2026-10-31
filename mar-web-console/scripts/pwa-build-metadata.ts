import type { Plugin } from 'vite';

// Vite puts its content-addressed outputs in assets/. Explicit
// fileName emissions do not have Rollup asset names and remain revisioned.
export function pwaBuildMetadata(prefix: '/'): Plugin {
  let serverBuild = false;
  return {
    name: 'mar-pwa-build-metadata',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      serverBuild = Boolean(config.build.ssr);
    },
    generateBundle(_options, bundle) {
      if (serverBuild) return;
      const immutable: string[] = [];
      const files: string[] = [];
      const modules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.fileName.startsWith('assets/')) files.push(prefix + output.fileName);
        if (output.type === 'chunk') {
          for (const id of output.moduleIds) modules.add(id);
          if (output.fileName.startsWith('assets/')) immutable.push(prefix + output.fileName);
        } else if (output.fileName.startsWith('assets/') && output.names.length > 0) {
          immutable.push(prefix + output.fileName);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: '.mar-pwa-build.json',
        source: JSON.stringify({ files, immutable, modules: [...modules] })
      });
    }
  };
}
