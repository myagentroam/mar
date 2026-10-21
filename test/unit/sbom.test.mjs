import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCycloneDxBom } from '../../scripts/create-sbom.mjs';
import {
  collectThirdPartyNotices,
  renderThirdPartyNotices
} from '../../scripts/create-third-party-notices.mjs';

test('CycloneDX SBOM removes local paths and deduplicates exact production packages', () => {
  const bom = createCycloneDxBom(
    { name: 'my-agent-roam', version: '1.2.3' },
    {
      MIT: [
        {
          name: '@scope/example',
          versions: ['2.0.0', '2.0.0'],
          paths: ['/private/workspace/node_modules/example'],
          license: 'MIT',
          homepage: 'https://example.com/project'
        }
      ],
      Unknown: [{ name: 'plain-package', versions: ['3.1.0'] }]
    }
  );

  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, '1.5');
  assert.deepEqual(
    bom.components.map((component) => component['bom-ref']),
    ['pkg:npm/%40scope/example@2.0.0', 'pkg:npm/plain-package@3.1.0']
  );
  assert.equal(JSON.stringify(bom).includes('/private/workspace'), false);
  assert.deepEqual(bom.components[0].licenses, [{ license: { name: 'MIT' } }]);
  assert.deepEqual(bom.components[1].licenses, [{ license: { name: 'Unknown' } }]);
});

test('CycloneDX SBOM rejects malformed product and package reports', () => {
  assert.throws(() => createCycloneDxBom({}, {}), /SBOM_PRODUCT_INVALID/u);
  assert.throws(
    () =>
      createCycloneDxBom(
        { name: 'my-agent-roam', version: '1.2.3' },
        { MIT: [{ name: '@invalid', versions: ['1.0.0'] }] }
      ),
    /SBOM_PACKAGE_INVALID/u
  );
});

test('release notices render exact installed package versions and supplied license texts', () => {
  const notices = renderThirdPartyNotices({ name: 'my-agent-roam', version: '1.2.3' }, [
    {
      name: 'zeta',
      version: '2.0.0',
      license: 'Apache-2.0',
      texts: [{ name: 'LICENSE', content: 'Zeta license text.' }]
    },
    {
      name: '@scope/alpha',
      version: '1.0.0',
      license: 'MIT',
      homepage: 'https://example.com/alpha',
      texts: [
        { name: 'LICENSE', content: 'Alpha license text.' },
        { name: 'NOTICE', content: 'Alpha notice text.' }
      ]
    }
  ]);
  assert.match(notices, /@scope\/alpha@1\.0\.0[\s\S]*Alpha license text/u);
  assert.match(notices, /Alpha notice text[\s\S]*zeta@2\.0\.0/u);
  assert.doesNotMatch(notices, /node_modules|\/private\//u);
});

test('release notices report dependencies without bundled license text without inventing content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-third-party-notices-'));
  try {
    const packagePath = join(directory, 'node_modules/example-package');
    await mkdir(packagePath, { recursive: true });
    await writeFile(
      join(packagePath, 'package.json'),
      JSON.stringify({ name: 'example-package', version: '4.5.6' })
    );

    const { packages, missing } = await collectThirdPartyNotices(
      {
        MIT: [
          {
            name: 'example-package',
            versions: ['4.5.6'],
            paths: [packagePath],
            license: 'MIT',
            homepage: 'https://example.com/package'
          }
        ]
      },
      directory
    );
    assert.deepEqual(packages, []);
    assert.deepEqual(missing, [
      {
        name: 'example-package',
        version: '4.5.6',
        license: 'MIT',
        homepage: 'https://example.com/package'
      }
    ]);

    const notices = renderThirdPartyNotices(
      { name: 'my-agent-roam', version: '1.2.3' },
      packages,
      missing
    );
    assert.match(notices, /Dependencies without bundled license text/u);
    assert.match(notices, /example-package@4\.5\.6 — declared license: MIT/u);
    assert.doesNotMatch(notices, /example license text|node_modules|mar-third-party-notices-/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
