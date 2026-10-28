import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Opt-in physical-desktop E2E. Never run alongside human desktop input.
const enabled =
  process.platform === 'win32' && process.env.MAR_TEST_WINDOWS_DESKTOP_EXCLUSIVE === '1';
test(
  'managed Computer Use types in Notepad, yields, waits and drains cancellation',
  {
    skip: enabled ? false : 'Requires an exclusively allocated interactive Windows desktop.',
    timeout: 120_000
  },
  async () => {
    const runtime = process.env.MAR_TEST_COMPUTER_USE_RUNTIME;
    assert(runtime, 'Set MAR_TEST_COMPUTER_USE_RUNTIME to the managed python.exe.');
    const artifacts = resolve(process.env.MAR_TEST_ARTIFACT_DIR ?? 'test/runs');
    await mkdir(artifacts, { recursive: true });
    const output = await mkdtemp(join(artifacts, 'computer-use-windows-'));
    console.log(`Computer Use artifacts: ${output}`);
    const textFile = join(output, 'notepad.txt');
    await writeFile(textFile, '', { flag: 'wx' });
    const notepad = spawn('notepad.exe', [textFile], { stdio: 'ignore' });
    const notepadClosed = once(notepad, 'close');
    void notepadClosed.catch(() => {});
    let journey, journeyClosed;
    try {
      await once(notepad, 'spawn');
      await writeFile(join(output, 'notepad-pid.txt'), String(notepad.pid));
      // Select only this test's window. Reacquire focus after independent CLI work.
      const focus = [
        'import ctypes,time',
        'from ctypes import wintypes',
        'assert pyautogui.FAILSAFE is True and pyautogui.PAUSE == 0.1',
        'user32 = ctypes.windll.user32',
        'user32.GetForegroundWindow.restype = wintypes.HWND',
        'user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]',
        'user32.IsWindowVisible.argtypes = [wintypes.HWND]',
        'user32.SetForegroundWindow.argtypes = [wintypes.HWND]',
        'user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]',
        'windows = []',
        '@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)',
        'def find_window(hwnd, unused):',
        '    pid = wintypes.DWORD()',
        '    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))',
        `    if pid.value == ${notepad.pid} and user32.IsWindowVisible(hwnd): windows.append(hwnd)`,
        '    return True',
        'user32.EnumWindows(find_window, 0)',
        'assert len(windows) == 1, "owned Notepad window unavailable"',
        'target = windows[0]',
        'if user32.GetForegroundWindow() != target:',
        '    pyautogui.press("alt")',
        '    user32.ShowWindow(target, 9)',
        '    user32.SetForegroundWindow(target)',
        '    time.sleep(0.1)',
        'assert user32.GetForegroundWindow() == target, "owned Notepad lost focus"'
      ].join('\n');
      const marker = (name, content) =>
        `pathlib.Path(${JSON.stringify(join(output, name))}).write_text(${content})`;
      const code = [
        focus,
        'pyautogui.write("MAR async ready")',
        'import pathlib',
        marker('started', '"started"'),
        '# Synchronization proves independent work overlaps the live task; not a speed benchmark.',
        `while not pathlib.Path(${JSON.stringify(join(output, 'work-done'))}).exists(): time.sleep(0.01)`,
        focus,
        'pyautogui.write(" complete")',
        'pyautogui.hotkey("ctrl", "s")'
      ].join('\n');
      const cancelCode = [
        'import pathlib,os,time',
        marker('cancel-started', 'str(os.getpid())'),
        'while True: time.sleep(0.01)'
      ].join('\n');
      const work = join(output, 'work.mjs');
      await writeFile(
        work,
        `import assert from 'node:assert/strict'; import {writeFile} from 'node:fs/promises'; const sum=Array.from({length:100},(_,i)=>i).reduce((a,b)=>a+b,0); assert.equal(sum,4950); await writeFile(${JSON.stringify(join(output, 'work-done'))},String(sum),{flag:'wx'});`,
        { flag: 'wx' }
      );
      const config = join(output, 'config.json');
      await writeFile(
        config,
        JSON.stringify({
          output,
          nodeDist: resolve(
            process.env.MAR_TEST_NODE_DIST ?? join(import.meta.dirname, '../../dist')
          ),
          runtime,
          code,
          cancelCode,
          work
        }),
        { flag: 'wx' }
      );
      journey = spawn(
        process.execPath,
        [join(import.meta.dirname, 'support/computer-use-journey.mjs'), config],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let log = '';
      for (const stream of [journey.stdout, journey.stderr])
        stream.on('data', (b) => {
          log = (log + b).slice(-32000);
        });
      journeyClosed = once(journey, 'close');
      const [status] = await journeyClosed;
      await writeFile(join(output, 'journey.log'), log);
      assert.equal(status, 0, log);
      assert.equal(
        (await readFile(textFile, 'utf8')).replace(/^\uFEFF/, ''),
        'MAR async ready complete'
      );
      assert.equal(await readFile(join(output, 'work-done'), 'utf8'), '4950');
      const report = JSON.parse(await readFile(join(output, 'runner-report.json'), 'utf8'));
      assert.equal(report.leaseReleased, true);
      assert.equal(report.executionCancellation, true);
    } finally {
      try {
        if (journey && journey.exitCode === null) {
          journey.kill();
          await journeyClosed;
        }
      } finally {
        // This child owns only the disposable test document; never close other Notepad windows.
        if (notepad.exitCode === null) notepad.kill();
        await notepadClosed;
      }
    }
  }
);
