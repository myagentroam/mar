import {
  createEnvelope,
  type NodeEnvelope,
  type WorkbenchEvent,
  type WorkbenchEventCategory
} from '@myagentroam/protocol';
import { isPlainRecord } from '../runner/codex/conversation-parser.js';
import {
  projectWorkbenchPayload,
  workbenchPayloadSessionId,
  type WorkbenchEventProjectionQueries
} from './workbench-event-projection.js';

interface WorkbenchEventServiceOptions {
  readonly send: (envelope: NodeEnvelope) => void;
  readonly accepts: (category: WorkbenchEventCategory, payload: unknown) => boolean;
  readonly projection: WorkbenchEventProjectionQueries;
  readonly emitRealtime: (sessionId: string, event: WorkbenchEvent) => boolean;
}

export class WorkbenchEventService {
  private sequence = 0;

  constructor(private readonly options: WorkbenchEventServiceOptions) {}

  dispatch(category: WorkbenchEventCategory, payload: unknown): void {
    payload = projectWorkbenchPayload(this.options.projection, category, payload);
    if (payload === undefined) return;
    const event = this.next(category, payload);
    if (event === undefined) return;
    const notification =
      category === 'conversation' &&
      isPlainRecord(payload) &&
      isPlainRecord(payload.event) &&
      payload.event.eventType === 'notification';
    const sessionId = workbenchPayloadSessionId(this.options.projection.getRun, category, payload);
    // A Watch owns pending buffering and observation drops as well as ready delivery.
    if (!notification && sessionId !== undefined && this.options.emitRealtime(sessionId, event))
      return;
    this.publish(event);
  }

  next(category: WorkbenchEventCategory, payload: unknown): WorkbenchEvent | undefined {
    if (!this.options.accepts(category, payload)) return undefined;
    return { sequence: ++this.sequence, category, payload };
  }

  publish(event: WorkbenchEvent): void {
    this.options.send(createEnvelope('workbench.event', event));
  }

  snapshotSequence(): number {
    return this.sequence;
  }
}
