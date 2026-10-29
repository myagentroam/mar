export type NodeShutdownStage =
  'waitForRecovery' | 'drainInput' | 'closeResume' | 'capture' | 'dispose' | 'publish';

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
      diagnose(stage: NodeShutdownStage, error: unknown): void;
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
    let failure: { error: unknown } | undefined;
    let stage: NodeShutdownStage = 'waitForRecovery';
    const failed = (error: unknown): void => {
      failure ??= { error };
      try {
        this.shutdown.diagnose(stage, error);
      } catch {
        // Diagnostics must not replace the shutdown failure or prevent cleanup.
      }
    };
    try {
      await this.shutdown.waitForRecovery();
      stage = 'drainInput';
      await this.shutdown.drainInput();
    } catch (error) {
      failed(error);
    }
    try {
      stage = 'closeResume';
      await this.shutdown.closeResume();
      if (failure === undefined && handoff) {
        stage = 'capture';
        snapshot = this.shutdown.capture();
      }
    } catch (error) {
      failed(error);
    }
    try {
      stage = 'dispose';
      await this.shutdown.dispose();
    } catch (error) {
      failed(error);
    }
    if (failure !== undefined) throw failure.error;
    if (snapshot !== undefined) {
      try {
        await this.shutdown.publish(snapshot);
      } catch (error) {
        stage = 'publish';
        failed(error);
        throw error;
      }
    }
  }
}
