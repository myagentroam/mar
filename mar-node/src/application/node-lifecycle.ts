/** Owns application start/stop serialization; domain resources remain owned by their services. */
export class NodeLifecycle<Snapshot = never> {
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private stoppedValue = false;
  private stopVersion = 0;

  constructor(
    private readonly startResources: () => Promise<void>,
    private readonly freeze: () => void,
    private readonly shutdown: {
      waitForRecovery(): Promise<void>;
      drainInput(): Promise<void>;
      closeResume(): Promise<void>;
      capture(): Snapshot | undefined;
      dispose(): Promise<void>;
      publish(snapshot: Snapshot): Promise<void>;
    }
  ) {}

  get stopped(): boolean {
    return this.stoppedValue;
  }

  start(): Promise<void> {
    if (this.starting !== undefined) return this.starting;
    const version = this.stopVersion;
    const operation = (async () => {
      if (this.stopping !== undefined) await this.stopping;
      if (version !== this.stopVersion) throw new Error('NODE_STOPPED');
      this.stopping = undefined;
      this.stoppedValue = false;
      try {
        await this.startResources();
      } catch (error) {
        this.freeze();
        this.stoppedValue = true;
        try {
          await this.stopResources(false);
        } catch {
          // Preserve the startup failure after attempting cleanup.
        }
        throw error;
      }
    })();
    this.starting = operation;
    void operation
      .finally(() => {
        if (this.starting === operation) this.starting = undefined;
      })
      .catch(() => {});
    return operation;
  }

  stop(handoff = false): Promise<void> {
    this.stopVersion += 1;
    if (this.stopping !== undefined) return this.stopping;
    this.stoppedValue = true;
    this.freeze();
    const starting = this.starting;
    const operation = (async () => {
      if (starting !== undefined) {
        try {
          await starting;
        } catch {
          // Failed startup already performed its own cleanup.
          return;
        }
      }
      await this.stopResources(handoff);
    })();
    this.stopping = operation;
    return operation;
  }

  private async stopResources(handoff: boolean): Promise<void> {
    let snapshot: Snapshot | undefined;
    let failure: unknown;
    try {
      await this.shutdown.waitForRecovery();
      await this.shutdown.drainInput();
    } catch (error) {
      failure = error;
    }
    try {
      await this.shutdown.closeResume();
      if (failure === undefined && handoff) snapshot = this.shutdown.capture();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.shutdown.dispose();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
    if (snapshot !== undefined) await this.shutdown.publish(snapshot);
  }
}
