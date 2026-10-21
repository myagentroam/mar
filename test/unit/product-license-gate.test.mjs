import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkProductLicense } from '../../scripts/check-product-license.mjs';

const licenseUrl = new URL('../../ee/LICENSE', import.meta.url);

test('the product ships final source-available terms without a pending marker', async () => {
  await checkProductLicense();
  await assert.rejects(readFile(new URL('../../ee/LICENSE.pending', import.meta.url)), {
    code: 'ENOENT'
  });
});

test('covered private package declarations use the final license identifier without checkout-relative paths', async () => {
  for (const packagePath of [
    'package.json',
    'mar-server/package.json',
    'mar-web-console/package.json',
    'ee/server/package.json',
    'ee/web/package.json'
  ]) {
    const packageUrl = new URL(`../../${packagePath}`, import.meta.url);
    const pkg = JSON.parse(await readFile(packageUrl, 'utf8'));
    assert.equal(pkg.private, true);
    assert.equal(pkg.license, 'LicenseRef-MAR-ESAL-1.0');
  }
});

test('public product release rejects missing, draft, empty and unrelated license documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-product-license-'));
  try {
    await mkdir(join(root, 'ee'));
    await assert.rejects(checkProductLicense(root), /PRODUCT_LICENSE_NOT_APPROVED/);
    const license = await readFile(licenseUrl, 'utf8');
    for (const text of [
      '',
      'Final license text fixture',
      'MAR Enterprise Edition License — DRAFT, NOT EFFECTIVE',
      `${license}\nDRAFT`,
      `${license}\nNOT EFFECTIVE`,
      `${license}\nPENDING_APPROVAL`
    ]) {
      await writeFile(join(root, 'ee/LICENSE'), text);
      await assert.rejects(checkProductLicense(root), /PRODUCT_LICENSE_NOT_APPROVED/);
    }
    await writeFile(join(root, 'ee/LICENSE'), license);
    await checkProductLicense(root);
    await writeFile(join(root, 'ee/LICENSE'), license.replaceAll('\n', '\r\n'));
    await checkProductLicense(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public product release rejects a truncated license instead of accepting its title alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-product-license-'));
  try {
    await mkdir(join(root, 'ee'));
    const license = await readFile(licenseUrl, 'utf8');
    for (const text of [license.split('\n')[0], license.split('\n12. ')[0]]) {
      await writeFile(join(root, 'ee/LICENSE'), text);
      await assert.rejects(checkProductLicense(root), /PRODUCT_LICENSE_NOT_APPROVED/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public product release rejects a missing license identifier, empty sections and reordered sections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-product-license-'));
  try {
    await mkdir(join(root, 'ee'));
    const license = await readFile(licenseUrl, 'utf8');
    const header = license.slice(0, license.indexOf('\n1. '));
    const sections = [...license.matchAll(/^\d+\. .+$/gmu)];
    const bodies = sections.map((section, index) =>
      license.slice(section.index, sections[index + 1]?.index ?? license.length)
    );
    assert.equal(sections.length, 12);
    const invalid = [
      license.replace('Local license identifier: LicenseRef-MAR-ESAL-1.0\n', ''),
      `${header}\n${sections.map((section) => section[0]).join('\n\n')}\n`,
      `${header}\n${[bodies[1], bodies[0], ...bodies.slice(2)].join('')}`
    ];
    for (const text of invalid) {
      await writeFile(join(root, 'ee/LICENSE'), text);
      await assert.rejects(checkProductLicense(root), /PRODUCT_LICENSE_NOT_APPROVED/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source licensing preserves the core boundary and enterprise activation is not distribution permission', async () => {
  const license = (await readFile(licenseUrl, 'utf8')).replace(/\s+/gu, ' ');
  const scope = (await readFile(new URL('../../LICENSING.md', import.meta.url), 'utf8')).replace(
    /\s+/gu,
    ' '
  );
  assert.match(license, /Enterprise Features require a valid Enterprise License/);
  assert.match(license, /An Enterprise License does not grant redistribution/);
  assert.match(license, /Independent Apache-2\.0 components/);
  assert.match(license, /HostedConversation/);
  assert.match(license, /Licensor and contact: aCHAOS \(achaosxyz@gmail\.com\)/);
  assert.match(license, /ordinary choice-of-law rules/);
  assert.match(scope, /LicenseRef-MAR-ESAL-1\.0/);
  assert.match(scope, /not an OSI-approved open-source license/);
});
