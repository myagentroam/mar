import { describe, expect, it } from 'vitest';
import {
  isConversationSegment,
  parseConversationSegmentPage,
  segmentPageAsTurnPage,
  syncConversationRunStatus
} from '../../src/util/conversation-segments.js';

const item = (id: string, kind: string) => ({ id, kind, status: 'COMPLETED', payload: {} });

describe('Web Conversation Segment', () => {
  it('Map Node segments to separate display pages while preserving actual Turn boundaries', () => {
    const page = segmentPageAsTurnPage({
      segments: [
        {
          id: 'turn-1:segment:1',
          turnId: 'turn-1',
          sessionId: 'session-1',
          runId: 'run-1',
          index: 1,
          status: 'SUCCEEDED',
          rewind: { before: null, after: 'native-turn-1' },
          items: [item('assistant-1', 'assistant_message')]
        }
      ],
      nextCursor: 'older'
    });

    expect(page.turns[0]).toMatchObject({
      id: 'turn-1:segment:1',
      turnId: 'turn-1',
      segmentIndex: 1,
      rewind: { after: 'native-turn-1' }
    });
  });

  it('The real-time segment structure guard rejects incomplete units', () => {
    const valid = {
      id: 'turn-1:segment:0',
      turnId: 'turn-1',
      sessionId: 'session-1',
      runId: null,
      index: 0,
      status: 'RUNNING',
      items: []
    };
    expect(isConversationSegment(valid)).toBe(true);
    expect(isConversationSegment({ ...valid, status: 'WAITING_INPUT' })).toBe(true);
    expect(isConversationSegment({ id: 'broken', items: [] })).toBe(false);
    expect(
      isConversationSegment({
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        sessionId: 'session-1',
        runId: 'run-1',
        index: 0,
        status: 'UNKNOWN',
        items: []
      })
    ).toBe(false);
    expect(
      isConversationSegment({
        id: 'turn-1:segment:0',
        turnId: 'turn-1',
        sessionId: 'session-1',
        runId: 'run-1',
        index: 0,
        status: 'RUNNING',
        items: [{}]
      })
    ).toBe(false);
    expect(isConversationSegment(null)).toBe(false);
  });

  it('Reject projection when the Segment page contains malformed units', () => {
    expect(() =>
      segmentPageAsTurnPage({
        unit: 'SEGMENT',
        segments: [{ id: 'broken' }],
        nextCursor: null
      } as never)
    ).toThrow('invalid Segment');
  });

  it('HTTP and real-time entry points share segment-page parsing and reject mixed-session pages', () => {
    const segment = (sessionId: string) => ({
      id: `${sessionId}:segment:0`,
      turnId: `${sessionId}:turn`,
      sessionId,
      runId: null,
      index: 0,
      status: 'SUCCEEDED',
      items: []
    });
    expect(
      parseConversationSegmentPage(
        {
          unit: 'SEGMENT',
          segments: [segment('session-1')],
          nextCursor: 'older',
          source: 'official'
        },
        7
      )
    ).toMatchObject({
      source: 'official',
      snapshotSequence: 7,
      nextCursor: 'older',
      turns: [expect.objectContaining({ sessionId: 'session-1' })]
    });
    expect(
      parseConversationSegmentPage({
        unit: 'SEGMENT',
        segments: [segment('session-1'), segment('session-2')],
        nextCursor: null
      })
    ).toBeUndefined();
  });

  it('Run status advances only the latest segment', () => {
    const segment = (id: string, segmentIndex: number, status: string) => ({
      id,
      turnId: 'turn-1',
      segmentIndex,
      sessionId: 'session-1',
      runId: 'run-1',
      status,
      items: []
    });
    const segments = syncConversationRunStatus(
      [segment('turn-1:segment:1', 1, 'RUNNING'), segment('turn-1:segment:0', 0, 'SUCCEEDED')],
      'run-1',
      'FAILED'
    );
    expect(segments.map((entry) => entry.status)).toEqual(['FAILED', 'SUCCEEDED']);
  });

  it('Run status never reopens a higher Segment from a preceding Turn', () => {
    const turns = [
      {
        id: 'old:segment:3',
        turnId: 'old',
        segmentIndex: 3,
        sessionId: 's',
        runId: 'r',
        status: 'SUCCEEDED',
        items: []
      },
      {
        id: 'new:segment:0',
        turnId: 'new',
        segmentIndex: 0,
        sessionId: 's',
        runId: 'r',
        status: 'PREPARING',
        items: []
      }
    ];
    expect(syncConversationRunStatus(turns, 'r', 'RUNNING').map((entry) => entry.status)).toEqual([
      'SUCCEEDED',
      'RUNNING'
    ]);
  });
});
