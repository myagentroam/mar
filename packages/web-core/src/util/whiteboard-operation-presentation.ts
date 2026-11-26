import {
  whiteboardOperationPresentationSchema,
  type WhiteboardOperationPresentation
} from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';

export function whiteboardOperation(payload: Record<string, unknown> | undefined) {
  const facts = payload?.whiteboardOperation;
  if (facts === undefined) return undefined;
  const parsed = whiteboardOperationPresentationSchema.safeParse(facts);
  return parsed.success ? parsed.data : undefined;
}

export function whiteboardOperationTitle(operation: WhiteboardOperationPresentation): string {
  return translate(`presentation.whiteboardOperation.${operation.action ?? 'unknown'}`);
}
