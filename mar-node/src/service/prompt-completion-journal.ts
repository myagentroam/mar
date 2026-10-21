import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

/** Local analysis only. Callers must supply credential-free, explicitly projected fields. */
export class PromptCompletionJournal {
  private tail: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;
  readonly directory: string;

  constructor(
    dataDirectory: string,
    private readonly now: () => number = Date.now
  ) {
    this.directory = join(dataDirectory, 'prompt-completion');
    void this.enqueue(() => this.prune());
    this.timer = setInterval(() => {
      void this.enqueue(() => this.prune());
    }, 60_000);
    this.timer.unref();
  }

  record(record: Readonly<Record<string, unknown>>): Promise<void> {
    // Capture before queueing so later mutations cannot alter a recorded request.
    const line = JSON.stringify(record) + '\n';
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.prune();
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const file = await open(
        join(this.directory, `${day}.jsonl`),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await file.writeFile(line, 'utf8');
      } finally {
        await file.close();
      }
    });
  }

  flush(): Promise<void> {
    return this.tail;
  }
  dispose(): void {
    clearInterval(this.timer);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(operation).catch(() => {
      console.warn('PROMPT_COMPLETION_JOURNAL_WRITE_FAILED');
    });
    return this.tail;
  }

  private async prune(): Promise<void> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
      const date = entry.name.slice(0, 10);
      if (date < cutoff || date > day) await unlink(join(this.directory, entry.name));
    }
  }
}
