import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1_000;

export class RotatingLogStream {
  private readonly activePath: string;
  private bytes = 0;
  private day = '';
  private rotation = 0;
  private lastCleanup = 0;

  constructor(
    directory: string,
    private readonly name: string,
    private readonly maxBytes = 100 * 1024 * 1024,
    private readonly retentionMs = 7 * DAY_MS,
    private readonly now: () => number = Date.now,
    private readonly mirrorToStdout = true
  ) {
    mkdirSync(directory, { recursive: true });
    this.activePath = resolve(directory, `${name}.log`);
    try {
      const stat = statSync(this.activePath);
      this.bytes = stat.size;
      this.day = new Date(stat.mtimeMs).toISOString().slice(0, 10);
    } catch {
      this.day = this.currentDay();
    }
    this.cleanup();
  }

  write(chunk: string | Uint8Array): boolean {
    const content = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const length = Buffer.byteLength(content);
    const day = this.currentDay();
    if (this.bytes > 0 && (this.bytes + length > this.maxBytes || day !== this.day)) this.rotate();
    appendFileSync(this.activePath, content, { encoding: 'utf8', mode: 0o600 });
    if (this.mirrorToStdout) process.stdout.write(content);
    this.bytes += length;
    this.day = day;
    if (this.now() - this.lastCleanup >= DAY_MS) this.cleanup();
    return true;
  }

  private currentDay(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private rotate(): void {
    const suffix = `${this.day}-${this.now()}-${String(this.rotation++).padStart(3, '0')}`;
    renameSync(this.activePath, resolve(this.activePath, '..', `${this.name}-${suffix}.log`));
    this.bytes = 0;
  }

  private cleanup(): void {
    const directory = resolve(this.activePath, '..');
    const cutoff = this.now() - this.retentionMs;
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(`${this.name}-`) || !entry.endsWith('.log')) continue;
      const path = resolve(directory, entry);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    }
    this.lastCleanup = this.now();
  }
}
