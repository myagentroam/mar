import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

interface ThirdPartyPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly root: string;
}

const mitLicenseText = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function packageForModule(moduleId: string): ThirdPartyPackage | undefined {
  const path = moduleId.split('?')[0]!;
  if (!path.includes('/node_modules/')) return undefined;
  let directory = dirname(path);
  while (directory.includes('/node_modules/')) {
    const packageJsonPath = resolve(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
          readonly name?: unknown;
          readonly version?: unknown;
          readonly license?: unknown;
        };
        if (typeof packageJson.name === 'string' && typeof packageJson.version === 'string') {
          return {
            name: packageJson.name,
            version: packageJson.version,
            license:
              typeof packageJson.license === 'string'
                ? packageJson.license
                : 'SEE INCLUDED LICENSE',
            root: directory
          };
        }
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

function licenseTexts(packageRoot: string): readonly string[] {
  const files = readdirSync(packageRoot, { withFileTypes: true });
  const texts = files
    .filter(
      (entry) => entry.isFile() && /^(license|copying|notice)([-._][\w-]+)?$/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort()
    .map((file) => readFileSync(resolve(packageRoot, file), 'utf8').trim());
  if (texts.length > 0) return texts;
  const readme = files.find((entry) => entry.isFile() && /^readme(\.[\w-]+)?$/i.test(entry.name));
  if (readme === undefined) return texts;
  const content = readFileSync(resolve(packageRoot, readme.name), 'utf8');
  const licenseSection = content
    .match(/^#{1,3}\s+license\s*$([\s\S]*)/im)?.[1]
    ?.split(/^#{1,3}\s/m)[0]
    ?.trim();
  return licenseSection === undefined || licenseSection.length === 0 ? texts : [licenseSection];
}

function declaredLicenseText(packageInfo: ThirdPartyPackage): string {
  const texts = licenseTexts(packageInfo.root);
  if (texts.length > 0) return texts.join('\n\n');
  if (packageInfo.license === 'MIT') return mitLicenseText;
  return 'License text is not included in this package distribution.';
}

export function thirdPartyNoticesPlugin(options: { readonly outputDirectory: string }): Plugin {
  const noticesPath = resolve(options.outputDirectory, 'THIRD_PARTY_NOTICES.txt');
  const serveNotices: Plugin['configureServer'] = (server) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/THIRD_PARTY_NOTICES.txt') {
        next();
        return;
      }
      if (!existsSync(noticesPath)) {
        response.statusCode = 503;
        response.end('Third-party notices are being generated.');
        return;
      }
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(readFileSync(noticesPath));
    });
  };
  return {
    name: 'myagentroam-third-party-notices',
    configureServer: serveNotices,
    generateBundle(_options, bundle) {
      const packages = new Map<string, ThirdPartyPackage>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const moduleId of output.moduleIds) {
          const packageInfo = packageForModule(moduleId);
          if (packageInfo !== undefined)
            packages.set(`${packageInfo.name}@${packageInfo.version}`, packageInfo);
        }
      }
      const notices = [...packages.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((packageInfo) => {
          const header = `${packageInfo.name} ${packageInfo.version}\nLicense: ${packageInfo.license}`;
          return `${header}\n${declaredLicenseText(packageInfo)}`;
        });
      const setiRoot = resolve(import.meta.dirname, '../src/icon-themes/seti/assets');
      const materialRoot = resolve(import.meta.dirname, '../src/icon-themes/material');
      notices.push(
        `Visual Studio Code Seti File Icon Theme\n${readFileSync(resolve(setiRoot, 'NOTICE.md'), 'utf8').trim()}\n\n${readFileSync(resolve(setiRoot, 'LICENSE.txt'), 'utf8').trim()}`
      );
      notices.push(
        `Material Design Icons\n${readFileSync(resolve(materialRoot, 'LICENSE.txt'), 'utf8').trim()}`
      );
      notices.push(
        `Material Icon Theme (subset)\n${readFileSync(resolve(materialRoot, 'UPSTREAM_LICENSE.txt'), 'utf8').trim()}`
      );
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: `MyAgentRoam Third-Party Open Source Software Notices\n\n${notices.join('\n\n' + '='.repeat(80) + '\n\n')}\n`
      });
    }
  };
}
