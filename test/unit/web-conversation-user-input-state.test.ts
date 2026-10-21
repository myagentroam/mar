import { describe, expect, it } from 'vitest';
import { displayConversationItem } from '../../ee/web/src/util/conversation-domain';

describe('Web Conversation input and approval display boundaries', () => {
  it('Pending questions display only when a Run identity exists', () => {
    const pendingInput = {
      id: 'input-1',
      kind: 'user_input_request',
      status: 'PENDING',
      payload: { requestId: 'request-1', questions: [] }
    } as never;
    expect(displayConversationItem(pendingInput, null)).toBe(false);
    expect(displayConversationItem(pendingInput, 'run-1')).toBe(true);
  });

  it('Approval requests render as ordinary Conversation Items', () => {
    expect(
      displayConversationItem(
        {
          id: 'approval:approval-1',
          kind: 'approval_request',
          status: 'PENDING',
          payload: { approvalId: 'approval-1', approvalStatus: 'PENDING' }
        } as never,
        'run-1'
      )
    ).toBe(true);
  });
});
