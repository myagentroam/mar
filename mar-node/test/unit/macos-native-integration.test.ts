import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeConfig } from '../../src/config.js';
import { ManagedComputerUseRuntime } from '../../src/computer-use-runtime.js';
import { bundledCtagsPath, repairBundledCtagsExecutable } from '../../src/ctags-binary.js';
import { probeComputerUse } from '../../src/runner/mar-agent/computer-use.js';
import { runCtags } from '../../src/service/code-navigation/ctags-index-storage.js';
import { removeServiceDefinition, writeServiceDefinition } from '../../src/service.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'mar-macos-native-'));
  directories.push(path);
  return path;
}

function command(executable: string, args: string[]) {
  return execFile(executable, args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

// Explicit opt-in: these checks start a private LaunchAgent and install the public runtime.
describe.runIf(process.platform === 'darwin' && process.env['MAR_MACOS_NATIVE_TESTS'] === '1')(
  'macOS native integrations',
  () => {
    it('loads and unloads the generated LaunchAgent with Unicode paths and its browser environment', async () => {
      const root = await directory();
      const configPath = join(root, "node 中文 & 'quotes'.json");
      const entrypoint = join(root, 'service fixture.mjs');
      const browserPath = join(root, 'browser cache & 中文');
      const ready = join(root, 'ready.json');
      const plist = join(root, 'node.plist');
      const label = `com.myagentroam.node.test-${randomUUID()}`;
      const domain = `gui/${process.getuid!()}`;
      const target = `${domain}/${label}`;
      await mkdir(browserPath);
      await writeFile(configPath, JSON.stringify({ ready }));
      await writeFile(
        entrypoint,
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          "const configPath = process.argv[process.argv.indexOf('--config') + 1];",
          "const { ready } = JSON.parse(readFileSync(configPath, 'utf8'));",
          'writeFileSync(ready, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), browser: process.env.PLAYWRIGHT_BROWSERS_PATH }));',
          'setInterval(() => {}, 1000);'
        ].join('\n')
      );
      await writeServiceDefinition(
        plist,
        process.execPath,
        configPath,
        'darwin',
        entrypoint,
        [],
        browserPath
      );
      await command('/usr/bin/plutil', ['-lint', plist]);
      await command('/usr/bin/plutil', ['-replace', 'Label', '-string', label, plist]);
      let loaded = false;
      try {
        await command('/bin/launchctl', ['bootstrap', domain, plist]);
        loaded = true;
        await expect.poll(() => readFile(ready, 'utf8'), { timeout: 10_000 }).toBeTruthy();
        const record = JSON.parse(await readFile(ready, 'utf8')) as {
          pid: number;
          args: string[];
          browser: string;
        };
        expect(record).toMatchObject({
          args: ['supervise', '--config', configPath],
          browser: browserPath
        });
        expect(processExists(record.pid)).toBe(true);
        await command('/bin/launchctl', ['print', target]);
        await command('/bin/launchctl', ['bootout', target]);
        loaded = false;
        await expect.poll(() => processExists(record.pid), { timeout: 10_000 }).toBe(false);
        await expect(command('/bin/launchctl', ['print', target])).rejects.toThrow();
        await removeServiceDefinition(plist);
        await expect(readFile(plist)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (loaded) await command('/bin/launchctl', ['bootout', target]);
      }
    }, 45_000);

    it('executes the bundled native ctags binary and indexes a Unicode source path', async () => {
      const root = await directory();
      const source = 'source with spaces 中文.ts';
      await writeFile(join(root, source), 'export function macosNativeProbe() { return 42; }\n');
      const list = join(root, 'sources.list');
      const tags = join(root, 'symbols.tags');
      await writeFile(list, `${source}\n`);
      await repairBundledCtagsExecutable();
      const executable = bundledCtagsPath();
      expect((await command(executable, ['--version'])).stdout).toContain('Universal Ctags');
      await runCtags(executable, root, list, tags);
      const output = await readFile(tags, 'utf8');
      expect(output).toMatch(/^macosNativeProbe\t/mu);
      expect(output).toContain(source);
    });

    it('loads the managed native Python runtime and checks desktop permissions without injecting input', async () => {
      const root = await directory();
      const config: NodeConfig = {
        serverUrl: 'https://server.example.invalid',
        allowedRoots: [root],
        dataDirectory: join(root, 'data'),
        computerUse: { enabled: true }
      };
      const runtime = new ManagedComputerUseRuntime(() => config, join(root, 'node.json'));
      const executable = await runtime.ensure();
      expect(await runtime.ensure()).toBe(executable);
      const { stdout } = await command(executable, [
        '-I',
        '-c',
        [
          'import ctypes, json, platform, sys, AppKit, Quartz, PIL, pyautogui, pyperclip',
          'services = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")',
          'graphics = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")',
          'services.AXIsProcessTrusted.restype = ctypes.c_bool',
          'graphics.CGPreflightPostEventAccess.restype = ctypes.c_bool',
          'print(json.dumps(dict(platform=sys.platform, architecture=platform.machine(), input=bool(services.AXIsProcessTrusted() and graphics.CGPreflightPostEventAccess()))))'
        ].join('\n')
      ]);
      const native = JSON.parse(stdout) as {
        platform: string;
        architecture: string;
        input: boolean;
      };
      expect(native.platform).toBe('darwin');
      expect(native.architecture).toBe(process.arch === 'arm64' ? 'arm64' : 'x86_64');
      const support = await probeComputerUse({ enabled: true, runtimeExecutable: executable });
      expect(support).toMatchObject({ platform: 'macos', backend: 'PYAUTOGUI' });
      expect(support.supportsInput).toBe(support.supportsScreenshot && native.input);
      expect(support.available).toBe(
        support.supportsScreenshot && support.supportsInput && support.supportsUnicodePaste
      );
      const { runtimeExecutable: _executable, ...evidence } = support;
      console.info(
        'MACOS_DESKTOP_EVIDENCE',
        JSON.stringify({ architecture: process.arch, ...evidence })
      );
    }, 660_000);
  }
);
