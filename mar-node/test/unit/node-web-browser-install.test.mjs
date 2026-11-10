import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { installWebBrowser } from '../../scripts/install-web-browser.mjs';

test('matching Chromium cache is registered with the pinned CLI and reused', async () => {
  const result = await installWebBrowser({
    environment: {},
    exists: async (path) => assert.match(path, /chromium/u),
    run: () => ({ status: 0 })
  });
  assert.equal(result, 'cached');
});

test('explicit offline skip avoids cache checks and downloads', async () => {
  for (const value of ['1', 'true']) {
    assert.equal(
      await installWebBrowser({
        environment: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: value },
        exists: () => assert.fail('Skip must not check the cache'),
        run: () => assert.fail('Skip must not download')
      }),
      'skipped'
    );
  }
});

test('cold installation uses the pinned dependency CLI without installing OS packages', async () => {
  let called = false;
  assert.equal(
    await installWebBrowser({
      environment: {},
      exists: async () => {
        if (!called) throw new Error('absent');
      },
      run: (command, args, options) => {
        called = true;
        assert.equal(command, process.execPath);
        assert.match(args[0], /playwright[/\\]cli\.js$/u);
        assert.deepEqual(args.slice(1), ['install', 'chromium', '--no-shell']);
        assert.equal(options.timeout, 12 * 60_000);
        assert.deepEqual(options.env, {});
        return { status: 0 };
      }
    }),
    'installed'
  );
  assert.equal(called, true);
});

test('failed or interrupted downloads fail installation with a safe actionable diagnosis', async () => {
  for (const result of [
    { status: 1 },
    { status: null, signal: 'SIGTERM' },
    { error: Object.assign(new Error('deadline exceeded'), { code: 'ETIMEDOUT' }) },
    { error: new Error('private proxy URL') }
  ]) {
    await assert.rejects(
      installWebBrowser({
        environment: {},
        exists: async () => {
          throw new Error('absent');
        },
        run: () => result
      }),
      { message: /NODE_WEB_BROWSER_INSTALL_FAILED: Chromium download failed/u }
    );
  }
});

test('the published Node package includes its postinstall entrypoint and pins Playwright', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  );
  assert.equal(manifest.scripts.postinstall, 'node scripts/install-web-browser.mjs');
  assert.ok(manifest.files.includes('scripts/install-web-browser.mjs'));
  assert.equal(manifest.dependencies.playwright, '1.62.1');
});

test('preparation rejects unusable executables even when the CLI reports success', async () => {
  await assert.rejects(
    installWebBrowser({
      environment: {},
      exists: async () => {
        throw new Error('not executable');
      },
      run: () => ({ status: 0 })
    }),
    /Chromium executable is unavailable/u
  );
});
