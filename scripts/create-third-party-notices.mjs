import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const licenseName = /^(?:licen[cs]e|copying|notice|copyright)(?:[._ -].*)?$/iu;
const productTargets = [
  '@myagentroam/server...',
  '@myagentroam/web-console...',
  '@myagentroam/node...'
];

function check(value, code) {
  if (!value) throw new Error(code);
}

function within(rootDirectory, path) {
  const value = relative(rootDirectory, path);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

export function renderThirdPartyNotices(product, packages, missing = []) {
  check(
    product &&
      typeof product.name === 'string' &&
      product.name.length > 0 &&
      typeof product.version === 'string' &&
      product.version.length > 0 &&
      Array.isArray(packages) &&
      Array.isArray(missing),
    'THIRD_PARTY_NOTICE_INPUT_INVALID'
  );
  const sorted = [...packages].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  );
  const sections = sorted.map((entry) => {
    check(
      entry &&
        typeof entry.name === 'string' &&
        entry.name.length > 0 &&
        typeof entry.version === 'string' &&
        entry.version.length > 0 &&
        typeof entry.license === 'string' &&
        entry.license.length > 0 &&
        Array.isArray(entry.texts) &&
        entry.texts.length > 0,
      'THIRD_PARTY_NOTICE_INPUT_INVALID'
    );
    const heading = [`## ${entry.name}@${entry.version}`, `Declared license: ${entry.license}`];
    if (typeof entry.homepage === 'string' && /^https?:\/\//u.test(entry.homepage))
      heading.push(`Project: ${entry.homepage}`);
    const texts = entry.texts.map(({ name, content }) => `### ${name}\n\n${content.trim()}\n`);
    return `${heading.join('\n')}\n\n${texts.join('\n')}`.trim();
  });
  const missingSection =
    missing.length === 0
      ? []
      : [
          [
            '## Dependencies without bundled license text',
            '',
            'The installed package did not include readable license or notice text. The declared license is recorded for audit visibility; no license text has been inferred or generated.',
            '',
            ...[...missing]
              .sort(
                (left, right) =>
                  left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
              )
              .map((entry) => {
                check(
                  entry &&
                    typeof entry.name === 'string' &&
                    entry.name.length > 0 &&
                    typeof entry.version === 'string' &&
                    entry.version.length > 0 &&
                    typeof entry.license === 'string' &&
                    entry.license.length > 0,
                  'THIRD_PARTY_NOTICE_INPUT_INVALID'
                );
                const project =
                  typeof entry.homepage === 'string' && /^https?:\/\//u.test(entry.homepage)
                    ? ` — project: ${entry.homepage}`
                    : '';
                return `- ${entry.name}@${entry.version} — declared license: ${entry.license}${project}`;
              })
          ].join('\n')
        ];
  const allSections = [...sections, ...missingSection];
  return [
    `# Third-party license notices for ${product.name}@${product.version}`,
    '',
    'This file contains license and notice text found in the installed production dependency graph. It does not replace the project license or a legal review of the complete distribution.',
    '',
    ...allSections.flatMap((section, index) => (index === 0 ? [section] : ['---', '', section])),
    ''
  ].join('\n');
}

async function packageLicenseTexts(directory, packagePath) {
  const canonical = await realpath(packagePath);
  check(
    within(directory, canonical) &&
      relative(directory, canonical).split(sep).includes('node_modules'),
    'THIRD_PARTY_NOTICE_PATH_INVALID'
  );
  const entries = await readdir(canonical, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const texts = [];
  const seen = new Set();
  for (const name of files) {
    const path = resolve(canonical, name);
    check((await stat(path)).size <= 2 * 1024 * 1024, 'THIRD_PARTY_NOTICE_TEXT_TOO_LARGE');
    const content = await readFile(path, 'utf8');
    if (!content.trim()) continue;
    const hash = createHash('sha256').update(content).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    texts.push({ name, content });
  }
  return texts;
}

export async function collectThirdPartyNotices(licenseReport, directory = root) {
  check(
    licenseReport && typeof licenseReport === 'object' && !Array.isArray(licenseReport),
    'THIRD_PARTY_NOTICE_INPUT_INVALID'
  );
  const packages = [];
  const missing = [];
  const seen = new Set();
  for (const [groupLicense, entries] of Object.entries(licenseReport)) {
    check(Array.isArray(entries), 'THIRD_PARTY_NOTICE_INPUT_INVALID');
    for (const entry of entries) {
      check(
        entry &&
          typeof entry.name === 'string' &&
          Array.isArray(entry.versions) &&
          Array.isArray(entry.paths) &&
          entry.versions.length === entry.paths.length,
        'THIRD_PARTY_NOTICE_INPUT_INVALID'
      );
      for (const [index, version] of entry.versions.entries()) {
        const key = `${entry.name}\0${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const texts = await packageLicenseTexts(resolve(directory), entry.paths[index]);
        if (texts.length === 0) {
          missing.push({
            name: entry.name,
            version,
            license:
              typeof entry.license === 'string' && entry.license.length > 0
                ? entry.license
                : groupLicense,
            ...(typeof entry.homepage === 'string' ? { homepage: entry.homepage } : {})
          });
          continue;
        }
        packages.push({
          name: entry.name,
          version,
          license:
            typeof entry.license === 'string' && entry.license.length > 0
              ? entry.license
              : groupLicense,
          ...(typeof entry.homepage === 'string' ? { homepage: entry.homepage } : {}),
          texts
        });
      }
    }
  }
  return {
    packages,
    missing: missing.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    )
  };
}

function productionLicenseArguments(targets) {
  check(
    Array.isArray(targets) &&
      targets.length > 0 &&
      targets.every((target) => typeof target === 'string' && target.length > 0),
    'THIRD_PARTY_NOTICE_TARGET_INVALID'
  );
  return [
    ...targets.flatMap((target) => ['--filter-prod', target]),
    'licenses',
    'list',
    '--prod',
    '--json'
  ];
}

export async function writeThirdPartyNotices(output, directory = root, targets = productTargets) {
  check(typeof output === 'string' && output.length > 0, 'THIRD_PARTY_NOTICE_OUTPUT_REQUIRED');
  const product = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const report = JSON.parse(
    execFileSync('pnpm', productionLicenseArguments(targets), {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  );
  const { packages, missing } = await collectThirdPartyNotices(report, directory);
  const notices = renderThirdPartyNotices(product, packages, missing);
  check(!notices.includes(`${resolve(directory)}/`), 'THIRD_PARTY_NOTICE_PATH_FORBIDDEN');
  await writeFile(resolve(output), notices, { flag: 'wx' });
  return { packages, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output] = process.argv.slice(2);
  await writeThirdPartyNotices(output);
}
