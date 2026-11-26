import { AgentError } from '@myagentroam/agent';
import type { ExtensionToolSpec } from '@myagentroam/agent/extensions';
import { z } from 'zod';
import { isPlainRecord } from '../../util/records.js';
import type { WhiteboardUpdate } from './whiteboard-store.js';

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const content = z.string().min(1).max(8192);
const operation = z.union([
  z.strictObject({ op: z.literal('add'), content }),
  z.strictObject({ op: z.literal('update'), id, expectedRevision: revision, content }),
  z.strictObject({ op: z.literal('del'), id, expectedRevision: revision }),
  z.strictObject({ op: z.literal('clear'), expectedBoardRevision: revision })
]);
const args = z.strictObject({
  action: z.enum(['read', 'join', 'leave', 'update']),
  // Responses strict mode sends null for unused optional operands.
  boardAgentId: id
    .nullish()
    .describe(
      'The Agent ID of the board owner. Required for join and update. For read, omit to read your own board.'
    ),
  ops: z
    .array(operation)
    .min(1)
    .max(128)
    .nullish()
    .describe('Required for update only. Operations run in the order listed.')
});

export type WhiteboardToolInput =
  | { readonly action: 'read'; readonly boardAgentId?: string }
  | { readonly action: 'join'; readonly boardAgentId: string }
  | { readonly action: 'leave' }
  | {
      readonly action: 'update';
      readonly boardAgentId: string;
      readonly ops: WhiteboardUpdate['ops'];
    };
export type WhiteboardInvoke = (executionId: string, input: WhiteboardToolInput) => unknown;

function invalidInput(): AgentError {
  return new AgentError(
    'WHITEBOARD_INPUT_INVALID',
    'Use read with an optional boardAgentId, join with boardAgentId, leave without operands, or update with boardAgentId and a non-empty ops list.'
  );
}

/** Reject extra top-level fields before the SDK can normalize them away. */
export function rejectExtraWhiteboardFields(input: unknown): void {
  if (isPlainRecord(input) && Object.keys(input).some((key) => !Object.hasOwn(args.shape, key)))
    throw invalidInput();
}

/** Model-facing contract for the one Whiteboard tool; it owns no board state. */
export function whiteboardTool(
  invoke: WhiteboardInvoke,
  currentExecution: () => string | undefined
): ExtensionToolSpec {
  return {
    name: 'whiteboard',
    allowedCallers: ['direct', 'programmatic'],
    // Joining changes which boards later calls (including sleep) use.
    parallelSafety: 'serial',
    description: [
      'Read, join, leave, or edit a whiteboard, a shared working memory for collaborating agents.',
      'Read your own board or another board in this workspace by Agent ID. Returns boardAgentId, boardRevision, entries with IDs and revisions, and up to 10 recentChanges.',
      'Join an active board by the owner’s Agent ID to receive it automatically. This replaces the one other board you follow, not your own board. Leave stops following that board without affecting your own. Leave takes no boardAgentId or ops.',
      'Update applies add, update, del, and clear in order to your own board or the board you follow. Update and del require the entry revision; clear requires the board revision. If any operation fails, none are applied.'
    ].join('\n\n'),
    inputSchema: z.toJSONSchema(args, { target: 'draft-7' }),
    parseInput(input): WhiteboardToolInput {
      const parsed = args.safeParse(input);
      if (parsed.success) {
        const { action, boardAgentId, ops } = parsed.data;
        if (ops == null) {
          if (action === 'read')
            return boardAgentId == null ? { action } : { action, boardAgentId };
          if (action === 'join' && boardAgentId != null) return { action, boardAgentId };
          if (action === 'leave' && boardAgentId == null) return { action };
        }
        if (action === 'update' && boardAgentId != null && ops)
          return { action, boardAgentId, ops };
      }
      throw invalidInput();
    },
    execute(payload, call) {
      call.signal.throwIfAborted();
      const executionId = currentExecution();
      if (!executionId)
        throw new AgentError(
          'WHITEBOARD_UNAVAILABLE',
          'No whiteboard is available for this execution.'
        );
      try {
        const data = invoke(executionId, payload as WhiteboardToolInput);
        return { data, content: JSON.stringify(data) };
      } catch (error) {
        // The SDK's model error text does not carry generic internal details.
        if (error instanceof AgentError && error.code.startsWith('WHITEBOARD_') && error.details) {
          throw new AgentError(
            error.code,
            `${error.publicMessage} ${JSON.stringify(error.details)}`,
            { details: error.details }
          );
        }
        throw error;
      }
    }
  };
}
