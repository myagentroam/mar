import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('unified Compose mounts Server SSH configuration read-only without creating host paths', async () => {
  const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');

  assert.match(compose, /source: \$\{MAR_SERVER_SSH_DIR:\?MAR_SERVER_SSH_DIR is required\}/u);
  assert.match(compose, /target: \/home\/node\/\.ssh/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /create_host_path: false/u);
});

test('unified Compose and Dockerfile pin upstream images while reusing internal build stages', async () => {
  const [compose, dockerfile] = await Promise.all([
    readFile(resolve(root, 'compose.yaml'), 'utf8'),
    readFile(resolve(root, 'Dockerfile'), 'utf8')
  ]);
  const composeImages = [...compose.matchAll(/^\s*image:\s*(\S+)/gmu)].map((match) => match[1]);
  const stages = new Set();
  const baseImages = [];
  for (const [, image, stage] of dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)/gmu)) {
    if (!stages.has(image)) baseImages.push(image);
    stages.add(stage);
  }
  const syntaxImage = dockerfile.match(/^# syntax=(\S+)/mu)?.[1];

  assert.equal(composeImages.length, 2);
  assert.equal(baseImages.length, 2);
  assert.ok(syntaxImage);
  for (const image of [...composeImages, ...baseImages, syntaxImage])
    assert.match(image, /^[^\s@]+@sha256:[0-9a-f]{64}$/u);
});

test('unified Server serves Web directly while preserving the site port', async () => {
  const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:5190:5190/u);
  assert.doesNotMatch(compose, /5191/u);
  assert.doesNotMatch(compose, /^  web:/mu);
});

test('Server installation and image do not bundle a Node execution domain', async () => {
  const [manifest, dockerfile] = await Promise.all([
    readFile(resolve(root, 'mar-server/package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'Dockerfile'), 'utf8')
  ]);
  assert.equal(manifest.dependencies['@myagentroam/node'], undefined);
  assert.doesNotMatch(dockerfile, /bubblewrap|install-deps.*chromium|installWebBrowser/u);
  assert.doesNotMatch(dockerfile, /COPY mar-node|COPY mar-agent|COPY marctl/u);
});

test('Server image reuses the pnpm store and trusts the copied lockfile', async () => {
  const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8');
  const storeMountedRuns = dockerfile
    .split(/\n(?=RUN )/u)
    .filter((block) => block.includes('id=myagentroam-pnpm-store-v11'));
  assert.equal(storeMountedRuns.length, 2);
  for (const run of storeMountedRuns) {
    assert.match(
      run,
      /--mount=type=cache,id=myagentroam-pnpm-cache,target=\/root\/\.cache\/pnpm,sharing=locked/u
    );
    assert.match(
      run,
      /id=myagentroam-pnpm-store-v11,target=\/root\/\.local\/share\/pnpm\/store,sharing=locked/u
    );
    assert.match(run, /\bpnpm --trust-lockfile\b/u);
  }
  assert.match(
    storeMountedRuns[0],
    /\bpnpm --trust-lockfile\b[\s\S]*\binstall --frozen-lockfile --prefer-offline/u
  );
  assert.match(
    storeMountedRuns[1],
    /\bpnpm --trust-lockfile\b[\s\S]*\bdeploy --prod \/runtime\/server/u
  );
});

test('Web image build copies marketing screenshots referenced by the portal', async () => {
  const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8');
  const webBuild = dockerfile.split('FROM dependencies AS web-build')[1]?.split('FROM ')[0] ?? '';
  assert.match(webBuild, /COPY docs\/assets docs\/assets/u);
  assert.match(webBuild, /COPY docs\/help docs\/help/u);
  const assetsCopyIndex = webBuild.indexOf('COPY docs/assets docs/assets');
  const buildIndex = webBuild.search(/RUN pnpm --filter @myagentroam\/web-console\.\.\. build/u);
  assert.ok(assetsCopyIndex >= 0 && buildIndex > assetsCopyIndex);
});
