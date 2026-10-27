/** Request-local observed generation intervals, excluding explicit execution pauses. */
export class ModelGenerationTiming {
  private startedAt: number | undefined;
  private latestAt: number | undefined;
  private duration = 0;
  private completed = false;
  private valid = true;

  start(at: number): void {
    if (this.completed) return;
    if (!Number.isFinite(at) || (this.latestAt !== undefined && at < this.latestAt)) {
      this.valid = false;
      return;
    }
    this.startedAt ??= at;
    this.latestAt = at;
  }

  pause(at: number): void {
    if (this.completed || this.startedAt === undefined) return;
    if (!Number.isFinite(at) || at < (this.latestAt ?? this.startedAt)) this.valid = false;
    else this.duration += at - this.startedAt;
    this.startedAt = undefined;
    this.latestAt = at;
  }

  finish(at: number): void {
    if (this.completed) return;
    if (!Number.isFinite(at) || (this.latestAt !== undefined && at < this.latestAt))
      this.valid = false;
    this.pause(at);
    this.completed = true;
  }

  get durationMs(): number | undefined {
    return this.completed && this.valid && this.duration >= 1_000 ? this.duration : undefined;
  }
}
