import {
  createEnvelope,
  type NodeEnvelope,
  type WorkbenchEvent,
  type WorkbenchEventCategory
} from '@myagentroam/protocol';

export class WorkbenchEventService {
  private sequence = 0;

  constructor(
    private readonly send: (envelope: NodeEnvelope) => void,
    private readonly accepts: (category: WorkbenchEventCategory, payload: unknown) => boolean
  ) {}

  next(category: WorkbenchEventCategory, payload: unknown): WorkbenchEvent | undefined {
    if (!this.accepts(category, payload)) return undefined;
    return { sequence: ++this.sequence, category, payload };
  }

  publish(event: WorkbenchEvent): void {
    this.send(createEnvelope('workbench.event', event));
  }

  snapshotSequence(): number {
    return this.sequence;
  }
}
