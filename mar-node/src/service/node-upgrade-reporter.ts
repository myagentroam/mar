export interface SupervisorUpgradeReport {
  readonly attemptId: string;
  readonly step: 'CLOSING_NODE' | 'INSTALLING' | 'WAITING_FOR_ONLINE';
  readonly result?: 'INSTALLED' | 'FAILED';
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly details?: string;
    readonly step: 'CLOSING_NODE' | 'INSTALLING' | 'WAITING_FOR_ONLINE';
    readonly kind: 'INSTALL' | 'START';
  };
  readonly operationEnded?: boolean;
}

/** A single in-flight report; changes replace the pending snapshot rather than queuing events. */
export class NodeUpgradeReporter {
  private readonly endpoint: URL;
  private readonly timer: NodeJS.Timeout;
  private pending: SupervisorUpgradeReport | undefined;
  private current: SupervisorUpgradeReport | undefined;
  private inFlight = false;
  private stopped = false;
  private controller: AbortController | undefined;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    serverUrl: string,
    nodeId: string,
    private readonly credential: string,
    private readonly send: typeof fetch = fetch
  ) {
    const endpoint = new URL(serverUrl);
    if (endpoint.protocol === 'ws:') endpoint.protocol = 'http:';
    if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:';
    if (
      endpoint.username ||
      endpoint.password ||
      (endpoint.protocol !== 'https:' &&
        !(
          endpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        ))
    )
      throw new Error('NODE_UPGRADE_REPORT_ORIGIN_INVALID');
    endpoint.pathname = `/api/nodes/${encodeURIComponent(nodeId)}/upgrade/report`;
    endpoint.search = '';
    endpoint.hash = '';
    this.endpoint = endpoint;
    this.timer = setInterval(() => {
      if (this.current !== undefined) this.update(this.current);
    }, 15_000);
    this.timer.unref();
  }

  update(report: SupervisorUpgradeReport): void {
    if (this.stopped) return;
    this.current = report;
    this.pending = report;
    void this.flush();
  }

  stop(): void {
    this.stopped = true;
    this.pending = undefined;
    clearInterval(this.timer);
    this.controller?.abort();
  }

  async finish(report: SupervisorUpgradeReport): Promise<void> {
    this.update(report);
    if (this.inFlight || this.pending !== undefined) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timeout);
          this.idleWaiters.delete(finish);
          resolve();
        };
        const timeout = setTimeout(finish, 5_000);
        this.idleWaiters.add(finish);
      });
    }
    this.stop();
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.inFlight || this.pending === undefined) return;
    const report = this.pending;
    this.pending = undefined;
    this.inFlight = true;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref();
    try {
      const response = await this.send(this.endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(report)
      });
      if (response.status === 401) this.stop();
      else if (response.ok) {
        const payload: unknown = await response.json();
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'state' in payload &&
          payload.state === 'SUCCEEDED'
        )
          this.stop();
      }
    } catch {
      // A failed report does not affect a local install; the next interval sends the latest snapshot.
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
      this.inFlight = false;
      if (this.pending !== undefined && !this.stopped) void this.flush();
      else for (const waiter of this.idleWaiters) waiter();
    }
  }
}
