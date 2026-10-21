import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PromptCompletionJournal } from '../../src/service/prompt-completion-journal.js';

describe('Prompt completion local analysis journal', () => {
  it('serializes records, preserves Unicode and retains only seven UTC days', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prompt-journal-'));
    const directory = join(root, 'prompt-completion');
    await mkdir(directory);
    for (const day of ['07', '08', '09', '10', '11', '12', '13'])
      await writeFile(join(directory, `2026-10-${day}.jsonl`), '{}\n');
    await writeFile(join(directory, 'notes.txt'), 'keep');
    let now = Date.parse('2026-10-14T23:59:59Z');
    const journal = new PromptCompletionJournal(root, () => now);
    try {
      await Promise.all([
        journal.record({ input: '检查接口', status: 'ready', output: '兼容性' }),
        journal.record({ status: 'cancelled' })
      ]);
      const lines = (await readFile(join(directory, '2026-10-14.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ input: '检查接口', output: '兼容性' });
      expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(7);
      expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('keep');
      if (process.platform !== 'win32')
        expect((await stat(join(directory, '2026-10-14.jsonl'))).mode & 0o777).toBe(0o600);
      now = Date.parse('2026-10-15T00:00:01Z');
      await journal.record({ status: 'empty' });
      expect(await readdir(directory)).not.toContain('2026-10-08.jsonl');
      expect(await readdir(directory)).toContain('2026-10-15.jsonl');
    } finally {
      journal.dispose();
      await journal.flush();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not fail prediction logging callers when storage is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prompt-journal-'));
    await writeFile(join(root, 'prompt-completion'), 'not a directory');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new PromptCompletionJournal(root);
    try {
      await expect(journal.record({ input: 'private input' })).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith('PROMPT_COMPLETION_JOURNAL_WRITE_FAILED');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private input');
    } finally {
      journal.dispose();
      await journal.flush();
      warning.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
