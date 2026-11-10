import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// Opt-in: build the candidate first and set MAR_SERVER_NPM_ARTIFACT to its absolute tarball path.
test(
  'candidate Server artifact installs with its actual production dependency graph',
  {
    skip: !process.env.MAR_SERVER_NPM_ARTIFACT,
    timeout: 600_000
  },
  () => {
    const artifact = resolve(process.env.MAR_SERVER_NPM_ARTIFACT);
    const fixture = mkdtempSync(join(tmpdir(), 'mar-server-artifact-'));
    try {
      const home = join(fixture, 'home');
      const consumer = join(fixture, 'consumer with spaces');
      mkdirSync(home);
      mkdirSync(consumer);
      const npmrc = join(fixture, 'empty.npmrc');
      const scopeRegistry = process.env.MAR_SERVER_NPM_SCOPE_REGISTRY;
      writeFileSync(npmrc, scopeRegistry ? `@myagentroam:registry=${scopeRegistry}\n` : '');
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        npm_config_userconfig: npmrc,
        npm_config_cache: join(fixture, 'cache'),
        PLAYWRIGHT_BROWSERS_PATH: process.env.MAR_TEST_BROWSER_CACHE ?? join(fixture, 'browsers')
      };
      delete env.npm_config_nodedir;
      delete env.npm_config_devdir;
      execFileSync(
        'npm',
        ['install', ...(scopeRegistry ? [] : ['--offline']), '--no-audit', '--no-fund', artifact],
        {
          cwd: consumer,
          env,
          stdio: 'pipe',
          timeout: 480_000
        }
      );
      // A later install must not re-resolve private workspace: ranges from bundled manifests.
      execFileSync('npm', ['install', '--offline', '--no-audit', '--no-fund', artifact], {
        cwd: consumer,
        env,
        stdio: 'pipe',
        timeout: 90_000
      });
      const server = join(consumer, 'node_modules', '@myagentroam', 'server');
      const serverManifest = JSON.parse(readFileSync(join(server, 'package.json'), 'utf8'));
      assert.equal(serverManifest.dependencies['@myagentroam/node'], serverManifest.version);
      assert.equal(serverManifest.bundleDependencies.includes('@myagentroam/node'), false);
      const nodeRequire = createRequire(
        createRequire(join(server, 'package.json')).resolve('@myagentroam/node/package.json')
      );
      for (const name of ['node-pty', 'node-datachannel', 'sharp']) assert.ok(nodeRequire(name));
      const ptyProbe = `
        const pty = require('node-pty');
        const child = pty.spawn(process.execPath, ['-e', "console.log('MAR_PTY_OK')"]);
        let output = '';
        child.onData(data => { output += data; });
        child.onExit(({exitCode}) => {
          if (exitCode !== 0 || !output.includes('MAR_PTY_OK')) process.exitCode = 1;
        });
      `;
      execFileSync(process.execPath, ['-e', ptyProbe], {
        cwd: dirname(nodeRequire.resolve('node-pty/package.json')),
        env,
        timeout: 10_000
      });
      const browser = execFileSync(
        process.execPath,
        ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"],
        {
          cwd: dirname(nodeRequire.resolve('playwright/package.json')),
          env,
          encoding: 'utf8'
        }
      );
      assert.equal(existsSync(browser), true, 'Node install must prepare Chromium');
      for (const file of [
        'LICENSE',
        'LICENSE.ee',
        'NOTICE',
        'LICENSING.md',
        'web/index.html',
        'web/docs/getting-started/npm-quick-start.html',
        'web/docs/en-US/getting-started/npm-quick-start.html'
      ])
        assert.equal(existsSync(join(server, file)), true, `Missing artifact file: ${file}`);
      const help = execFileSync(
        process.execPath,
        [join(server, 'dist/quick-start/cli.js'), '--help'],
        {
          cwd: consumer,
          env,
          encoding: 'utf8',
          timeout: 10_000
        }
      );
      assert.match(help, /setup/u);
      const globalPrefix = join(fixture, 'global');
      execFileSync(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          globalPrefix,
          ...(scopeRegistry ? [] : ['--offline']),
          '--no-audit',
          '--no-fund',
          artifact
        ],
        { cwd: consumer, env, stdio: 'pipe', timeout: 90_000 }
      );
      const globalBin =
        process.platform === 'win32'
          ? join(globalPrefix, 'mar-server.cmd')
          : join(globalPrefix, 'bin/mar-server');
      assert.equal(existsSync(globalBin), true);
      const globalPackage =
        process.platform === 'win32'
          ? join(globalPrefix, 'node_modules/@myagentroam/server')
          : join(globalPrefix, 'lib/node_modules/@myagentroam/server');
      assert.match(
        execFileSync(process.execPath, [join(globalPackage, 'dist/quick-start/cli.js'), '--help'], {
          cwd: consumer,
          env,
          encoding: 'utf8',
          timeout: 10_000
        }),
        /setup/u
      );
      // The independent npm exec probe does not need the global installation.
      rmSync(globalPrefix, { recursive: true, force: true });
      const npxConsumer = join(fixture, 'npx-consumer');
      mkdirSync(npxConsumer);
      writeFileSync(join(npxConsumer, 'package.json'), '{"private":true}');
      assert.match(
        execFileSync(
          'npm',
          [
            'exec',
            ...(scopeRegistry ? [] : ['--offline']),
            '--yes',
            `--package=${artifact}`,
            '--',
            'mar-server',
            '--help'
          ],
          {
            cwd: npxConsumer,
            env,
            encoding: 'utf8',
            timeout: 90_000
          }
        ),
        /setup/u
      );
      assert.equal(existsSync(join(home, '.myagentroam')), false);
      const serverRequire = createRequire(join(server, 'package.json'));
      for (const [parent, dependency, version] of [
        ['ajv', 'fast-uri', '3.1.5'],
        ['light-my-request', 'process-warning', '4.0.1'],
        ['thread-stream', 'real-require', '1.0.0']
      ]) {
        const fromParent = createRequire(serverRequire.resolve(parent));
        let directory = dirname(fromParent.resolve(dependency));
        while (!existsSync(join(directory, 'package.json'))) {
          const previous = directory;
          directory = dirname(directory);
          assert.notEqual(directory, previous, `No manifest for ${dependency}`);
        }
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        assert.equal(manifest.name, dependency);
        assert.equal(manifest.version, version, `${parent} -> ${dependency}`);
      }
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import.meta.resolve('@myagentroam-enterprise/server-implementation'); import.meta.resolve('@myagentroam/server-core/mar-agent-resource-input-service'); import.meta.resolve('@myagentroam/protocol');"
        ],
        { cwd: server, env, stdio: 'pipe', timeout: 10_000 }
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);
