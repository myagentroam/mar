import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productTargets = [
  '@myagentroam/server...',
  '@myagentroam/web-console...',
  '@myagentroam/node...'
];

function check(value, code) {
  if (!value) throw new Error(code);
}

function packageUrl(name, version) {
  const segments = name.startsWith('@') ? name.split('/') : [name];
  check(
    segments.length === (name.startsWith('@') ? 2 : 1) && segments.every(Boolean),
    'SBOM_PACKAGE_INVALID'
  );
  const path = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

export function createCycloneDxBom(product, licenseReport) {
  check(
    product &&
      typeof product.name === 'string' &&
      product.name.length > 0 &&
      typeof product.version === 'string' &&
      product.version.length > 0,
    'SBOM_PRODUCT_INVALID'
  );
  check(
    licenseReport && typeof licenseReport === 'object' && !Array.isArray(licenseReport),
    'SBOM_LICENSE_REPORT_INVALID'
  );
  const components = new Map();
  for (const [groupLicense, entries] of Object.entries(licenseReport)) {
    check(Array.isArray(entries), 'SBOM_LICENSE_REPORT_INVALID');
    for (const entry of entries) {
      check(
        entry &&
          typeof entry.name === 'string' &&
          Array.isArray(entry.versions) &&
          entry.versions.every((version) => typeof version === 'string' && version.length > 0),
        'SBOM_PACKAGE_INVALID'
      );
      const license =
        typeof entry.license === 'string' && entry.license.length > 0
          ? entry.license
          : groupLicense;
      for (const version of entry.versions) {
        const bomRef = packageUrl(entry.name, version);
        const component = {
          type: 'library',
          'bom-ref': bomRef,
          name: entry.name,
          version,
          purl: bomRef,
          licenses: [{ license: { name: license } }]
        };
        if (typeof entry.author === 'string' && entry.author.length > 0)
          component.author = entry.author;
        if (typeof entry.description === 'string' && entry.description.length > 0)
          component.description = entry.description;
        if (typeof entry.homepage === 'string' && /^https?:\/\//u.test(entry.homepage))
          component.externalReferences = [{ type: 'website', url: entry.homepage }];
        components.set(bomRef, component);
      }
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `application:${product.name}@${product.version}`,
        name: product.name,
        version: product.version
      }
    },
    components: [...components.values()].sort((left, right) =>
      left['bom-ref'].localeCompare(right['bom-ref'])
    )
  };
}

function productionLicenseArguments(targets) {
  check(
    Array.isArray(targets) &&
      targets.length > 0 &&
      targets.every((target) => typeof target === 'string' && target.length > 0),
    'SBOM_TARGET_INVALID'
  );
  return [
    ...targets.flatMap((target) => ['--filter-prod', target]),
    'licenses',
    'list',
    '--prod',
    '--json'
  ];
}

export async function writeSbom(output, directory = root, targets = productTargets) {
  check(typeof output === 'string' && output.length > 0, 'SBOM_OUTPUT_REQUIRED');
  const product = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const report = JSON.parse(
    execFileSync('pnpm', productionLicenseArguments(targets), {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  );
  const bom = createCycloneDxBom(product, report);
  const serialized = `${JSON.stringify(bom, null, 2)}\n`;
  check(!serialized.includes(`${resolve(directory)}/`), 'SBOM_ABSOLUTE_PATH_FORBIDDEN');
  await writeFile(resolve(output), serialized, { flag: 'wx' });
  return bom;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output] = process.argv.slice(2);
  await writeSbom(output);
}
