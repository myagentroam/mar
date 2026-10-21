import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationDisplayItems,
  conversationErrorCodeVisible,
  conversationErrorPresentation,
  conversationFileChangeEntries,
  conversationItemDetail,
  conversationItemLabel,
  conversationItemText,
  subagentGroupText,
  subagentOperationText,
  taskListItems,
  reasoningDisclosureOpen,
  reasoningPreview,
  approvalDetail,
  approvalReason,
  permissionStopDetail
} from '../../src/util/conversation-presentation';
import { activePlanContinuation } from '../../src/util/conversation-domain';
import type { ConversationItem } from '../../src/model/workbench';
import { conversationUiEnUS, conversationUiZhCN } from '../../src/i18n/conversation-ui';
import { localePreferenceService, translate } from '../../src/service/LocalePreferenceService';
import { contextUsageAfterCompaction } from '../../src/service/ConversationStateService';
import { ApiError } from '../../src/util/api-error';
import { errorMessage } from '../../src/util/error-presentation';

function item(
  id: string,
  kind: string,
  payload: unknown = {},
  status: ConversationItem['status'] = 'COMPLETED'
): ConversationItem {
  return { id, kind, status, payload };
}

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));
const zhPresentation = conversationUiZhCN.presentation;
const enPresentation = conversationUiEnUS.presentation;
const zhGeneratedPresentation = conversationUiZhCN.generated.conversationPresentation;
const enGeneratedPresentation = conversationUiEnUS.generated.conversationPresentation;
const zhNodeMessages = conversationUiZhCN.nodeMessages;
const zhDomain = conversationUiZhCN.generated.conversationDomain;
const zhColon = String.fromCodePoint(0xff1a);

describe('Runner approval details', () => {
  it('preserves reason, command and working directory without rendering HTML', () => {
    const approval = {
      id: 'approval',
      status: 'PENDING' as const,
      expiresAt: 0,
      payload: {
        toolName: 'exec',
        reason: 'Confirm target.',
        input: { command: 'echo <target>', cwd: '/fixture' }
      }
    };
    expect(approvalReason(approval)).toBe('Confirm target.');
    expect(approvalDetail(approval).text).toContain('echo <target>');
    expect(approvalDetail(approval).text).toContain('/fixture');
  });

  it('shows code and parameters and marks bounded detail truncation', () => {
    const approval = {
      id: 'approval',
      status: 'PENDING' as const,
      expiresAt: 0,
      payload: { input: { code: 'x'.repeat(70_000) } }
    };
    const detail = approvalDetail(approval);
    expect(detail.text).toContain('x'.repeat(100));
    expect(detail.text.length).toBeLessThan(66_000);
    expect(detail.text).toContain(translate('presentation.truncated'));
    const stop = item('stop', 'tool_call', {
      inputSummary: JSON.stringify({ path: '/fixture/file' })
    });
    expect(permissionStopDetail(stop).text).toContain('/fixture/file');
  });
});

describe('Conversation Show Aggregation', () => {
  it('never hides permission stops inside tool, command, subagent, or image groups', () => {
    for (const kind of ['tool_call', 'command_execution', 'subagent', 'image_generation']) {
      const blocked = {
        ...item('blocked', kind),
        permissionStop: {
          action: 'ask' as const,
          reason: 'Confirm target.',
          source: {
            sessionId: 'session',
            executionId: 'execution',
            callId: 'call',
            toolName: 'effect'
          }
        }
      };
      const projected = conversationDisplayItems([blocked]);
      expect(projected).toEqual([{ type: 'item', id: 'blocked', item: blocked }]);
    }
  });
  beforeEach(() => localePreferenceService().setLocale('zh-CN'));

  it('labels scheduled user inputs without treating ordinary message text as a command', () => {
    expect(
      conversationItemLabel('user_message', { source: 'SCHEDULED', text: '/goal Review' })
    ).toBe('定时任务');
    expect(conversationItemLabel('user_message', { text: '/goal Review' })).toBe('你');
  });

  it('Keep localized error summaries together with details and request identifiers', () => {
    const message = errorMessage(
      new ApiError(
        'HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID',
        'The rollback target is invalid.',
        {},
        'The history boundary changed.',
        'server-request-1',
        'node-request-1'
      ),
      'The rollback boundary changed'
    );

    expect(message).toContain('The rollback boundary changed');
    expect(message).toContain('HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID');
    expect(message).toContain('The history boundary changed.');
    expect(message).toContain('server-request-1');
    expect(message).toContain('node-request-1');
  });

  it('localizes ChatGPT usage limits while retaining diagnostics in both locales', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      localePreferenceService().setLocale(locale);
      const message = errorMessage(
        new ApiError(
          'subscription_sharing_usage_limit_exceeded',
          'Upstream usage limit.',
          {},
          'Original details',
          'server-usage-request',
          'node-usage-request'
        )
      );
      expect(message).toContain(
        locale === 'zh-CN' ? 'ChatGPT 套餐或本应用' : 'Your ChatGPT plan or this app'
      );
      expect(message).toContain('subscription_sharing_usage_limit_exceeded');
      expect(message).toContain('Original details');
      expect(message).toContain('server-usage-request');
      expect(message).toContain('node-usage-request');
    }
  });

  it('Aggregate grouping mounts details only after expansion', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/view/conversation/ConversationTimeline.vue'),
      'utf8'
    );

    expect(source).toContain(
      'v-if="groupedItemDisclosure[displayItem.id]" class="conversation-tool-list"'
    );
    expect(source).toContain(
      'v-if="groupedItemDisclosure[displayItem.id]" class="conversation-command-list"'
    );
    expect(source).toContain('v-if="reasoningDisclosure[displayItem.id]">{{ displayItem.text }}');
    expect(source).toMatch(
      /v-if="groupedItemDisclosure\[displayItem\.id\]"\s+class="conversation-file-change-list"/u
    );
    expect(
      source.match(
        /conversationItemText\(\s*displayItem\.item\.kind,\s*displayItem\.item\.payload,\s*displayItem\.item\.status\s*\)/gu
      )
    ).toHaveLength(5);
  });

  it('Render image-generation results in standalone cards with their generated attachments', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/view/conversation/ConversationTimeline.vue'),
      'utf8'
    );
    const start = source.indexOf(
      '<template v-else-if="displayItem.type === \'image_generation\'">'
    );
    const end = source.indexOf('<template v-else-if="displayItem.type === \'tool_group\'">');
    const imageGeneration = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(imageGeneration).toContain("translate('presentation.imageGeneration')");
    expect(imageGeneration).toContain(
      'props.imageAttachments(turn.runId, displayItem.item.payload)'
    );
    expect(imageGeneration).toContain(':source="attachment.previewUrl"');
  });

  it('Keep HTTP status, error code, and message presentation separate in error cards', () => {
    const payload = {
      code: 'insufficient_user_quota',
      httpStatus: 403,
      message: 'subscription quota insufficient, need=431775'
    };
    expect(conversationErrorPresentation(payload)).toEqual(payload);
    expect(conversationItemText('error', payload)).toBe(
      'subscription quota insufficient, need=431775'
    );
    expect(conversationItemDetail('error', payload)).toBe('');
    expect(
      conversationErrorCodeVisible(
        conversationErrorPresentation({
          code: 'HTTP_504',
          httpStatus: 504,
          message: 'Model endpoint returned HTTP 504.'
        })
      )
    ).toBe(false);
    expect(conversationErrorCodeVisible(conversationErrorPresentation(payload))).toBe(true);

    expect(
      conversationItemText('error', {
        code: 'RUNNER_FAILED',
        message: 'RUNNER_FAILED'
      })
    ).toBe('RUNNER_FAILED');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'preserves execution-budget errors without subscription guidance in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const payload = {
        code: 'MAR_AGENT_ROLLOUT_BUDGET_EXCEEDED',
        message: 'The shared execution token budget has been exhausted.',
        recoverable: true,
        retryAfterMs: null
      };
      const presentation = conversationErrorPresentation(payload);
      expect(presentation).toMatchObject({ code: payload.code, message: payload.message });
      expect(conversationErrorCodeVisible(presentation)).toBe(true);
      expect(conversationItemText('error', payload)).toBe(payload.message);
      expect(conversationItemDetail('error', payload)).toBe('');
    }
  );

  it('adds plain-text ChatGPT usage guidance without mutating or hiding upstream errors', () => {
    const payload = {
      code: 'subscription_sharing_usage_limit_exceeded',
      httpStatus: 429,
      message: 'Original upstream diagnostic.'
    };
    for (const locale of ['zh-CN', 'en-US'] as const) {
      localePreferenceService().setLocale(locale);
      const result = conversationErrorPresentation(payload);
      expect(result.code).toBe(payload.code);
      expect(result.httpStatus).toBe(429);
      expect(result.message).toContain('https://chatgpt.com/settings/usage');
      expect(result.message).toContain(
        locale === 'zh-CN' ? '请打开' : 'Open https://chatgpt.com/settings/usage'
      );
      expect(result.message).toContain(payload.message);
      expect(conversationErrorPresentation({ code: payload.code }).message).toContain(
        'https://chatgpt.com/settings/usage'
      );
      expect(payload.message).toBe('Original upstream diagnostic.');
    }
  });

  it('uses English labels when the interface locale is English', () => {
    localePreferenceService().setLocale('en-US');
    expect(conversationItemLabel('reasoning_summary')).toBe('Reasoning');
    expect(conversationItemText('command_execution', { outputPreview: 'done' })).toBe(
      'Command execution'
    );
  });

  it('Display the complete non-image attachment prompt returned by Node in a user message', () => {
    const runnerInput =
      'Read the attachment\n\nAttachments available in the Workspace:\n- .mar/temp-files/run/notes.pdf';

    expect(conversationItemText('user_message', { text: runnerInput })).toBe(runnerInput);
  });

  it('moves reasoning, tool, and command groups to their latest appended member', () => {
    const items = [
      item('reasoning-1', 'reasoning_summary', { sections: [{ text: 'First check' }] }),
      item('tool-1', 'tool_call', { toolName: 'read' }),
      item('command-1', 'command_execution', { command: 'pwd' })
    ];
    expect(conversationDisplayItems(items).map((entry) => entry.id)).toEqual([
      'reasoning-1',
      'tool-1',
      'command-1'
    ]);

    items.push(item('reasoning-2', 'reasoning_summary', { sections: [{ text: 'Next check' }] }));
    const afterReasoning = conversationDisplayItems(items);
    expect(afterReasoning.map((entry) => entry.id)).toEqual(['tool-1', 'command-1', 'reasoning-1']);
    expect(afterReasoning.at(-1)).toMatchObject({
      type: 'reasoning_group',
      id: 'reasoning-1',
      items: [{ id: 'reasoning-1' }, { id: 'reasoning-2' }],
      text: 'First check\n\nNext check'
    });

    items.push(item('tool-2', 'tool_call', { toolName: 'write' }));
    expect(conversationDisplayItems(items).map((entry) => entry.id)).toEqual([
      'command-1',
      'reasoning-1',
      'tool-1'
    ]);
    items.push(item('command-2', 'command_execution', { command: 'git status' }));
    expect(conversationDisplayItems(items).map((entry) => entry.id)).toEqual([
      'reasoning-1',
      'tool-1',
      'command-1'
    ]);
    expect(afterReasoning.at(-1)).toMatchObject({
      items: [{ id: 'reasoning-1' }, { id: 'reasoning-2' }]
    });
  });

  it.each([
    ['reasoning_summary', 'reasoning_group'],
    ['tool_call', 'tool_group'],
    ['command_execution', 'command_group'],
    ['file_change', 'file_change_group']
  ])('places %s groups at their last member while preserving independent cards', (kind, type) => {
    const items = [
      item('first', kind),
      item('warning', 'warning', { message: 'A notice' }),
      item('plan', 'plan'),
      item('approval', 'approval_request'),
      item('question', 'user_input_request'),
      item('subagent', 'tool_call', { subagentOperation: 'START', subagentId: 'child' }),
      item('image', 'tool_call', { toolCategory: 'IMAGE_GENERATION' }),
      item('last', kind),
      item('assistant', 'assistant_message', { text: 'Done' })
    ];
    const original = structuredClone(items);
    const displayItems = conversationDisplayItems(items);

    expect(displayItems.map((entry) => entry.id)).toEqual([
      'warning',
      'plan',
      'approval',
      'question',
      'subagent',
      'image',
      'first',
      'assistant'
    ]);
    expect(displayItems.at(-2)).toMatchObject({
      type,
      id: 'first',
      items: [{ id: 'first' }, { id: 'last' }]
    });
    expect(items).toEqual(original);
    expect(conversationDisplayItems(structuredClone(items))).toEqual(displayItems);
  });

  it('does not reorder groups for content, status, or timestamp updates to existing members', () => {
    const items = [
      item(
        'reasoning',
        'reasoning_summary',
        { sections: [{ text: 'First check' }] },
        'IN_PROGRESS'
      ),
      item('tool', 'tool_call', { toolName: 'read' }, 'IN_PROGRESS'),
      item('command', 'command_execution', { command: 'pwd' }, 'IN_PROGRESS')
    ];
    const originalIds = conversationDisplayItems(items).map((entry) => entry.id);
    const updatedItems = items.map((entry, index) => ({
      ...entry,
      status: 'COMPLETED',
      startedAt: 300 - index * 100,
      completedAt: 600 - index * 100,
      payload: index === 0 ? { sections: [{ text: 'Updated check' }] } : entry.payload
    }));

    const displayItems = conversationDisplayItems(updatedItems);
    expect(displayItems.map((entry) => entry.id)).toEqual(originalIds);
    expect(displayItems[0]).toMatchObject({ text: 'Updated check' });
  });

  it('Merge consecutive commands within the same Turn with a stable group ID', () => {
    const displayItems = conversationDisplayItems([
      item('user', 'user_message', { text: 'Check the status' }),
      item('command-1', 'command_execution', { command: 'pwd' }),
      item('command-2', 'command_execution', { command: 'git status' }),
      item('assistant', 'assistant_message', { text: 'The Workspace is clean' })
    ]);

    expect(displayItems.map((displayItem) => displayItem.type)).toEqual([
      'item',
      'command_group',
      'item'
    ]);
    const commandGroup = displayItems[1];
    expect(commandGroup?.type).toBe('command_group');
    if (commandGroup?.type === 'command_group') {
      expect(commandGroup.id).toBe('command-1');
      expect(commandGroup.items.map((candidate) => candidate.id)).toEqual([
        'command-1',
        'command-2'
      ]);
    }
  });

  it('Aggregate consecutive Agent bodies within the same Segment into one message card', () => {
    const displayItems = conversationDisplayItems([
      item('assistant-1', 'assistant_message', { text: 'Although this is a product rule,' }),
      item('assistant-2', 'assistant_message', { text: 'the code has no single decision point' })
    ]);

    expect(displayItems).toHaveLength(1);
    expect(displayItems[0]).toMatchObject({
      type: 'item',
      id: 'assistant-1',
      item: {
        id: 'assistant-1',
        kind: 'assistant_message',
        payload: {
          text: 'Although this is a product rule,\n\nthe code has no single decision point'
        }
      }
    });
  });

  it('Do not merge Agent text across a tool call within the same Segment', () => {
    const displayItems = conversationDisplayItems([
      item('assistant-1', 'assistant_message', { text: 'Check this first' }),
      item('tool', 'tool_call', { namespace: 'codex', toolName: 'read' }),
      item('assistant-2', 'assistant_message', { text: 'The check is complete' })
    ]);

    expect(displayItems.map((displayItem) => displayItem.id)).toEqual([
      'assistant-1',
      'tool',
      'assistant-2'
    ]);
  });

  it('Do not move activity after an Agent message into earlier aggregate cards', () => {
    const displayItems = conversationDisplayItems([
      item('assistant-1', 'assistant_message', { text: 'Phase one starts' }),
      item('command-1', 'command_execution', { command: 'pwd' }),
      item('reasoning-1', 'reasoning_summary', { sections: [{ text: 'First check' }] }),
      item('command-2', 'command_execution', { command: 'git status' }),
      item('assistant-2', 'assistant_message', { text: 'Phase two starts' }),
      item('command-3', 'command_execution', { command: 'git diff' }),
      item('reasoning-2', 'reasoning_summary', { sections: [{ text: 'Second check' }] }),
      item('command-4', 'command_execution', { command: 'git log -1' }),
      item('assistant-3', 'assistant_message', { text: 'Done' })
    ]);

    expect(displayItems.map((displayItem) => displayItem.type)).toEqual([
      'item',
      'reasoning_group',
      'command_group',
      'item',
      'reasoning_group',
      'command_group',
      'item'
    ]);
    expect(
      displayItems
        .filter((displayItem) => displayItem.type === 'reasoning_group')
        .map((displayItem) =>
          displayItem.type === 'reasoning_group'
            ? displayItem.items.map((candidate) => candidate.id)
            : []
        )
    ).toEqual([['reasoning-1'], ['reasoning-2']]);
    expect(
      displayItems
        .filter((displayItem) => displayItem.type === 'command_group')
        .map((displayItem) =>
          displayItem.type === 'command_group'
            ? displayItem.items.map((candidate) => candidate.id)
            : []
        )
    ).toEqual([
      ['command-1', 'command-2'],
      ['command-3', 'command-4']
    ]);
  });

  it.each(['IN_PROGRESS', 'COMPLETED', 'FAILED'])(
    'ends the reasoning phase at %s context compaction',
    (status) => {
      const items = [
        item('reasoning-before', 'reasoning_summary', { sections: [{ text: 'Before compact' }] }),
        item('command-before', 'command_execution', { command: 'pwd' }),
        item('compact', 'context_compaction', { phase: 'STARTED' }, status),
        item('command-after', 'command_execution', { command: 'git status' }),
        item('reasoning-after', 'reasoning_summary', { sections: [{ text: 'After compact' }] })
      ];
      const displayItems = conversationDisplayItems(items);
      expect(displayItems.map((entry) => entry.id)).toEqual([
        'reasoning-before',
        'command-before',
        'compact',
        'command-after',
        'reasoning-after'
      ]);
      expect(displayItems.filter((entry) => entry.type === 'reasoning_group')).toMatchObject([
        { id: 'reasoning-before', completed: true, text: 'Before compact' },
        { id: 'reasoning-after', completed: false, text: 'After compact' }
      ]);
      expect(items[0]?.status).toBe('COMPLETED');
      expect(conversationDisplayItems(items.slice(3))).toMatchObject([
        { id: 'command-after' },
        { id: 'reasoning-after', completed: false }
      ]);
    }
  );

  it('keeps background compaction from completing reasoning until the anchored prefix is installed', () => {
    const before = item('reasoning-before', 'reasoning_summary', {
      sections: [{ text: 'Before compact' }]
    });
    const anchor = item('anchor-message', 'assistant_message', {
      text: 'Snapshot anchor',
      format: 'markdown',
      model: null
    });
    const after = item('reasoning-after', 'reasoning_summary', {
      sections: [{ text: 'Continued work' }]
    });
    const background = item(
      'compact',
      'context_compaction',
      { phase: 'STARTED', mode: 'BACKGROUND', stage: 'GENERATING', anchorItemId: anchor.id },
      'IN_PROGRESS'
    );
    const items = [before, anchor, after, background];

    const generating = conversationDisplayItems(items);
    expect(generating.map((entry) => entry.id)).toEqual([
      'reasoning-before',
      'anchor-message',
      'compact',
      'reasoning-after'
    ]);
    expect(generating.filter((entry) => entry.type === 'reasoning_group')).toMatchObject([
      { completed: false, text: 'Before compact' },
      { completed: false, text: 'Continued work' }
    ]);

    const waiting = {
      ...background,
      payload: {
        phase: 'STARTED',
        mode: 'BACKGROUND',
        stage: 'WAITING',
        anchorItemId: anchor.id
      }
    };
    const failed = {
      ...background,
      status: 'FAILED',
      payload: {
        phase: 'STARTED',
        mode: 'BACKGROUND',
        stage: 'GENERATING',
        anchorItemId: anchor.id,
        code: 'MAR_AGENT_COMPACT_FAILED'
      }
    };
    for (const state of [waiting, failed])
      expect(
        conversationDisplayItems([before, anchor, state, after])
          .filter((entry) => entry.type === 'reasoning_group')
          .every((entry) => entry.type !== 'reasoning_group' || !entry.completed)
      ).toBe(true);

    const installed = {
      ...background,
      status: 'COMPLETED',
      payload: {
        phase: 'COMPLETED',
        mode: 'BACKGROUND',
        retainedContext: true,
        anchorItemId: anchor.id
      }
    };
    expect(
      conversationDisplayItems([before, anchor, after, installed]).filter(
        (entry) => entry.type === 'reasoning_group'
      )
    ).toMatchObject([{ completed: true }, { completed: false }]);

    const unresolved = {
      ...installed,
      payload: { ...installed.payload, anchorItemId: 'not-on-this-page' }
    };
    const unresolvedDisplay = conversationDisplayItems([before, unresolved, after]);
    expect(unresolvedDisplay.map((entry) => entry.id)).toEqual([
      'reasoning-before',
      'compact',
      'reasoning-after'
    ]);
    expect(unresolvedDisplay.filter((entry) => entry.type === 'reasoning_group')).toMatchObject([
      { completed: false },
      { completed: false }
    ]);
  });

  it('places background compaction after its anchored tool item', () => {
    const before = item('reasoning-before', 'reasoning_summary', {
      sections: [{ text: 'Compacted prefix' }]
    });
    const anchor = item('snapshot-tool', 'tool_call', {
      namespace: 'mar-agent',
      toolName: 'read'
    });
    const after = item('reasoning-after', 'reasoning_summary', {
      sections: [{ text: 'Continued after snapshot' }]
    });
    const compact = item(
      'compact',
      'context_compaction',
      {
        phase: 'COMPLETED',
        mode: 'BACKGROUND',
        anchorItemId: anchor.id
      },
      'COMPLETED'
    );

    const displayItems = conversationDisplayItems([before, anchor, after, compact]);
    expect(displayItems.map((entry) => entry.id)).toEqual([
      'reasoning-before',
      'snapshot-tool',
      'compact',
      'reasoning-after'
    ]);
    expect(displayItems.filter((entry) => entry.type === 'reasoning_group')).toMatchObject([
      { completed: true, text: 'Compacted prefix' },
      { completed: false, text: 'Continued after snapshot' }
    ]);
  });

  it('keeps an explicitly blocking wait at its anchor without completing reasoning until installation', () => {
    const before = item('reasoning-before', 'reasoning_summary', {
      sections: [{ text: 'Compacted prefix' }]
    });
    const anchor = item('snapshot-anchor', 'assistant_message', {
      text: 'Snapshot anchor',
      format: 'markdown',
      model: null
    });
    const after = item('reasoning-after', 'reasoning_summary', {
      sections: [{ text: 'Continued after snapshot' }]
    });
    const compact = (mode: string, stage: string, phase = 'STARTED', status = 'IN_PROGRESS') =>
      item(
        'compact',
        'context_compaction',
        { phase, mode, stage, anchorItemId: anchor.id },
        status
      );
    const ids = ['reasoning-before', 'snapshot-anchor', 'compact', 'reasoning-after'];

    for (const state of [compact('BACKGROUND', 'GENERATING'), compact('BLOCKING', 'WAITING')]) {
      const display = conversationDisplayItems([before, anchor, after, state]);
      expect(display.map((entry) => entry.id)).toEqual(ids);
      expect(display.filter((entry) => entry.type === 'reasoning_group')).toMatchObject([
        { completed: false, text: 'Compacted prefix' },
        { completed: false, text: 'Continued after snapshot' }
      ]);
    }

    const installed = compact('BACKGROUND', 'GENERATING', 'COMPLETED', 'COMPLETED');
    const display = conversationDisplayItems([before, anchor, after, installed]);
    expect(display.map((entry) => entry.id)).toEqual(ids);
    expect(display.filter((entry) => entry.type === 'reasoning_group')).toMatchObject([
      { completed: true, text: 'Compacted prefix' },
      { completed: false, text: 'Continued after snapshot' }
    ]);
  });

  it.each(['assistant_message', 'context_compaction'])(
    'completes reasoning when %s separates phases in an unsplit Segment',
    (kind) => {
      const displayItems = conversationDisplayItems([
        item('reasoning-before', 'reasoning_summary', { sections: [{ text: 'Before boundary' }] }),
        item('boundary', kind, { text: 'Phase complete' }),
        item('reasoning-after', 'reasoning_summary', { sections: [{ text: 'After boundary' }] })
      ]);
      expect(displayItems.filter((entry) => entry.type === 'reasoning_group')).toMatchObject([
        { id: 'reasoning-before', completed: true },
        { id: 'reasoning-after', completed: false }
      ]);
    }
  );

  it.each(['reasoning_summary', 'tool_call', 'command_execution', 'file_change'])(
    'keeps %s groups separate across consecutive compactions and preserves member updates',
    (kind) => {
      const items = [
        item('before-1', kind),
        item('before-2', kind),
        item('compact-1', 'context_compaction', { phase: 'STARTED' }, 'IN_PROGRESS'),
        item('compact-2', 'context_compaction', { phase: 'STARTED' }, 'IN_PROGRESS'),
        item('after-1', kind),
        item('after-2', kind)
      ];
      const before = conversationDisplayItems(items);
      expect(before.map((entry) => entry.id)).toEqual([
        'before-1',
        'compact-1',
        'compact-2',
        'after-1'
      ]);
      expect(
        before
          .filter((entry) => 'items' in entry)
          .map((entry) => ('items' in entry ? entry.items.map((member) => member.id) : []))
      ).toEqual([
        ['before-1', 'before-2'],
        ['after-1', 'after-2']
      ]);
      items[1] = { ...items[1]!, status: 'FAILED', completedAt: 999, payload: { text: 'Updated' } };
      items[2] = { ...items[2]!, status: 'COMPLETED', payload: { phase: 'COMPLETED' } };
      expect(conversationDisplayItems(items).map((entry) => entry.id)).toEqual(
        before.map((entry) => entry.id)
      );
    }
  );

  it('Non-adjacent command and file changes within the same Segment are still merged separately', () => {
    const displayItems = conversationDisplayItems([
      item('command-1', 'command_execution', { command: 'one' }),
      item('warning', 'warning', { message: 'A notice in between' }),
      item('command-2', 'command_execution', { command: 'two' }),
      item('change-1', 'file_change', {
        changes: [{ path: 'src/a.ts', change: 'MODIFIED' }]
      }),
      item('change-2', 'file_change', {
        changes: [{ path: 'src/b.ts', change: 'ADDED' }]
      })
    ]);

    expect(displayItems.map((displayItem) => displayItem.type)).toEqual([
      'item',
      'command_group',
      'file_change_group'
    ]);
    expect(
      displayItems
        .filter((displayItem) => displayItem.type === 'command_group')
        .map((displayItem) => (displayItem.type === 'command_group' ? displayItem.items.length : 0))
    ).toEqual([2]);
  });

  it('Merge thinking within segments and let the same kind of items separated by thinking naturally aggregate', () => {
    const displayItems = conversationDisplayItems([
      item('user', 'user_message', { text: 'Run the check' }),
      item('command-1', 'command_execution', { command: 'pwd' }),
      item('reasoning-1', 'reasoning_summary', { sections: [{ text: 'Check the catalog first' }] }),
      item('command-2', 'command_execution', { command: 'git status' }),
      item('reasoning-2', 'reasoning_summary', { sections: [{ text: 'Then check the status' }] }),
      item('command-3', 'command_execution', { command: 'git diff' }),
      item('assistant', 'assistant_message', { text: 'The results look normal' })
    ]);

    expect(displayItems.map((displayItem) => displayItem.type)).toEqual([
      'item',
      'reasoning_group',
      'command_group',
      'item'
    ]);
    const commandGroups = displayItems.filter(
      (displayItem) => displayItem.type === 'command_group'
    );
    expect(commandGroups).toHaveLength(1);
    expect(
      commandGroups.map((displayItem) =>
        displayItem.type === 'command_group' ? displayItem.items.length : 0
      )
    ).toEqual([3]);
    const reasoningGroup = displayItems.find(
      (displayItem) => displayItem.type === 'reasoning_group'
    );
    expect(reasoningGroup?.type).toBe('reasoning_group');
    if (reasoningGroup?.type === 'reasoning_group') {
      expect(reasoningGroup.id).toBe('reasoning-1');
      expect(reasoningGroup.items.map((candidate) => candidate.id)).toEqual([
        'reasoning-1',
        'reasoning-2'
      ]);
      expect(reasoningGroup.text).toBe('Check the catalog first\n\nThen check the status');
    }
  });

  it('Aggregate ordinary tools across reasoning while preserving subagent and other item boundaries', () => {
    const ordinaryTool = (id: string) =>
      item(id, 'tool_call', { namespace: 'codex', toolName: 'read', title: 'read' });
    const displayItems = conversationDisplayItems([
      ordinaryTool('tool-1'),
      item('reasoning-1', 'reasoning_summary', { sections: [{ text: 'Keep reading' }] }),
      ordinaryTool('tool-2'),
      item('reasoning-2', 'reasoning_summary', { sections: [{ text: 'Keep checking' }] }),
      ordinaryTool('tool-3'),
      item('subagent', 'tool_call', {
        namespace: 'collaboration',
        toolName: 'spawn_agent',
        title: 'Inspect the implementation',
        subagentOperation: 'START',
        subagentId: null
      }),
      ordinaryTool('tool-4'),
      item('plan', 'plan', { explanation: 'Next step' }),
      ordinaryTool('tool-5')
    ]);

    expect(displayItems.map((displayItem) => displayItem.type)).toEqual([
      'reasoning_group',
      'subagent_group',
      'item',
      'tool_group'
    ]);
    expect(
      displayItems
        .filter((displayItem) => displayItem.type === 'tool_group')
        .map((displayItem) => (displayItem.type === 'tool_group' ? displayItem.items.length : 0))
    ).toEqual([5]);
  });

  it('Keep image-generation items separate from ordinary tool groups', () => {
    const displayItems = conversationDisplayItems([
      item('tool-1', 'tool_call', {
        namespace: 'workspace',
        toolName: 'read',
        title: 'read'
      }),
      item('image', 'tool_call', {
        namespace: 'media',
        toolName: 'generate',
        title: 'generate',
        toolCategory: 'IMAGE_GENERATION',
        attachments: [
          {
            name: 'generated.png',
            mime: 'image/png',
            runId: 'native-history:session-1',
            imageIndex: 0
          }
        ]
      }),
      item('tool-2', 'tool_call', {
        namespace: 'workspace',
        toolName: 'write',
        title: 'write'
      })
    ]);

    expect(displayItems.map((displayItem) => displayItem.type)).toEqual([
      'image_generation',
      'tool_group'
    ]);
    expect(displayItems[1]).toMatchObject({
      type: 'tool_group',
      items: [{ id: 'tool-1' }, { id: 'tool-2' }]
    });
    expect(displayItems[0]).toMatchObject({
      type: 'image_generation',
      item: { id: 'image' }
    });
    const imageGeneration = displayItems[0];
    expect(
      conversationItemLabel(
        'tool_call',
        imageGeneration?.type === 'image_generation' ? imageGeneration.item.payload : undefined
      )
    ).toBe(zhPresentation.imageGeneration);

    localePreferenceService().setLocale('en-US');
    expect(
      conversationItemLabel(
        'tool_call',
        imageGeneration?.type === 'image_generation' ? imageGeneration.item.payload : undefined
      )
    ).toBe(enPresentation.imageGeneration);
  });

  it('Do not classify an ordinary tool as image generation just because it returns an image', () => {
    const [displayItem] = conversationDisplayItems([
      item('view-image', 'tool_call', {
        namespace: 'workspace',
        toolName: 'view_image',
        title: 'view_image',
        attachments: [
          {
            name: 'screenshot.png',
            mime: 'image/png',
            runId: 'run-1',
            imageIndex: 0
          }
        ]
      })
    ]);

    expect(displayItem).toMatchObject({
      type: 'tool_group',
      items: [{ id: 'view-image' }]
    });
    expect(
      conversationItemLabel('tool_call', {
        toolCategory: 'IMAGE_GENERATION'
      })
    ).toBe(zhPresentation.imageGeneration);
  });

  it('Show a dedicated image-generation card and running status before an attachment exists', () => {
    const [displayItem] = conversationDisplayItems([
      item(
        'image-running',
        'tool_call',
        {
          namespace: 'media',
          toolName: 'generate',
          title: 'generate',
          toolCategory: 'IMAGE_GENERATION'
        },
        'IN_PROGRESS'
      )
    ]);

    expect(displayItem).toMatchObject({
      type: 'image_generation',
      item: { id: 'image-running' }
    });
    expect(
      conversationItemText(
        'tool_call',
        displayItem?.type === 'image_generation' ? displayItem.item.payload : undefined,
        'IN_PROGRESS'
      )
    ).toBe(zhNodeMessages.generatingImage);
  });

  it('Preserve file names, statuses, and order when merging file changes', () => {
    const entries = conversationFileChangeEntries([
      item('change-1', 'file_change', {
        changes: [{ path: 'src/a.ts', change: 'MODIFIED' }]
      }),
      item('change-2', 'file_change', {
        changes: [
          { path: 'src/b.ts', change: 'ADDED' },
          { path: 'src/c.ts', change: 'DELETED' }
        ]
      })
    ]);

    expect(entries).toEqual([
      { path: 'src/a.ts', change: 'MODIFIED', status: zhPresentation.fileChangeModified },
      { path: 'src/b.ts', change: 'ADDED', status: zhPresentation.fileChangeAdded },
      { path: 'src/c.ts', change: 'DELETED', status: zhPresentation.fileChangeDeleted }
    ]);

    localePreferenceService().setLocale('en-US');
    expect(
      conversationFileChangeEntries([
        item('change-en', 'file_change', {
          changes: [{ path: 'src/a.ts', change: 'MODIFIED' }]
        })
      ])
    ).toEqual([{ path: 'src/a.ts', change: 'MODIFIED', status: 'Modified' }]);
  });

  it('Retain a displayable command record when only its output is available', () => {
    expect(conversationItemText('command_execution', { outputPreview: 'Command output' })).toBe(
      zhGeneratedPresentation.commandExecution
    );
  });

  it('Use a quantity-free reasoning title and consistent running and completed labels', () => {
    expect(conversationItemLabel('reasoning_summary')).toBe(zhGeneratedPresentation.reasoning);
    expect(
      conversationItemText(
        'reasoning_summary',
        { sections: [{ text: 'The check is complete' }] },
        'COMPLETED'
      )
    ).toBe(zhGeneratedPresentation.thoughtCompleted);
    expect(conversationItemText('reasoning_summary', { sections: [] }, 'IN_PROGRESS')).toBe(
      zhGeneratedPresentation.thinking
    );
    expect(conversationItemText('reasoning_summary', { sections: [] }, 'COMPLETED')).toBe(
      zhGeneratedPresentation.thoughtCompleted
    );
  });

  it('Uses the item status for context-compaction labels', () => {
    expect(conversationItemLabel('context_compaction')).toBe('上下文整理');
    expect(conversationItemText('context_compaction', { phase: 'STARTED' }, 'IN_PROGRESS')).toBe(
      '整理中'
    );
    expect(
      conversationItemText(
        'context_compaction',
        { phase: 'STARTED', mode: 'BACKGROUND', stage: 'GENERATING' },
        'IN_PROGRESS'
      )
    ).toBe(zhGeneratedPresentation.contextCompactionBackground);
    expect(
      conversationItemText(
        'context_compaction',
        { phase: 'STARTED', mode: 'BACKGROUND', stage: 'READY' },
        'IN_PROGRESS'
      )
    ).toBe(zhGeneratedPresentation.contextCompactionReady);
    expect(
      conversationItemText(
        'context_compaction',
        { phase: 'STARTED', mode: 'BACKGROUND', stage: 'WAITING' },
        'IN_PROGRESS'
      )
    ).toBe(zhGeneratedPresentation.contextCompactionWaiting);
    expect(
      conversationItemText(
        'context_compaction',
        { phase: 'COMPLETED', summaryCode: 'CONTEXT_COMPACTED' },
        'COMPLETED'
      )
    ).toBe(zhNodeMessages.contextCompacted);
    expect(conversationItemText('context_compaction', { phase: 'STARTED' }, 'CANCELLED')).toBe(
      zhGeneratedPresentation.stopped
    );
    expect(conversationItemText('context_compaction', { phase: 'STARTED' }, 'INTERRUPTED')).toBe(
      zhGeneratedPresentation.stopped
    );
    expect(conversationItemText('context_compaction', { phase: 'STARTED' }, 'FAILED')).toBe(
      zhGeneratedPresentation.failed
    );
    expect(
      conversationItemText(
        'context_compaction',
        { phase: 'STARTED', code: 'MAR_AGENT_COMPACT_FAILED' },
        'FAILED'
      )
    ).toBe(zhGeneratedPresentation.contextCompactionFailed);
    expect(
      conversationItemText(
        'context_compaction',
        { phase: 'STARTED', code: 'MAR_AGENT_COMPACT_CANCELLED' },
        'CANCELLED'
      )
    ).toBe(zhGeneratedPresentation.contextCompactionCancelled);
    localePreferenceService().setLocale('en-US');
    expect(conversationItemLabel('context_compaction')).toBe('Context compaction');
    expect(conversationItemText('context_compaction', { phase: 'STARTED' }, 'IN_PROGRESS')).toBe(
      'Compacting'
    );
    expect(
      conversationItemText(
        'context_compaction',
        { phase: 'STARTED', mode: 'BACKGROUND', stage: 'WAITING' },
        'IN_PROGRESS'
      )
    ).toBe(enGeneratedPresentation.contextCompactionWaiting);
  });

  it('treats retained post-compaction context usage as unknown but preserves the empty reset baseline', () => {
    const previous = { model: 'coding', usedTokens: 18_000, maxTokens: 200_000, percentage: 9 };
    const zero = { model: 'coding', usedTokens: 0, maxTokens: 200_000, percentage: 0 };
    expect(
      contextUsageAfterCompaction(
        { kind: 'context_compaction', status: 'COMPLETED', payload: { retainedContext: true } },
        previous
      )
    ).toBeNull();
    expect(
      contextUsageAfterCompaction(
        { kind: 'context_compaction', status: 'COMPLETED', payload: { retainedContext: false } },
        previous
      )
    ).toEqual(zero);
    expect(
      contextUsageAfterCompaction(
        { kind: 'context_compaction', status: 'IN_PROGRESS', payload: { retainedContext: true } },
        previous
      )
    ).toBe(previous);
    expect(
      contextUsageAfterCompaction(
        { kind: 'context_compaction', status: 'COMPLETED', payload: { phase: 'COMPLETED' } },
        previous
      )
    ).toEqual(zero);
  });

  it('Do not create expandable content for empty context compaction, plans, or file changes', () => {
    const compacted = item('compaction', 'context_compaction', {
      phase: 'COMPLETED',
      summaryCode: 'CONTEXT_COMPACTED'
    });
    expect(conversationItemDetail(compacted.kind, compacted.payload)).toBe('');
    expect(conversationItemText(compacted.kind, compacted.payload)).toBe(
      zhNodeMessages.contextCompacted
    );

    const emptyPlan = item('plan', 'plan');
    expect(conversationItemText(emptyPlan.kind, emptyPlan.payload)).toBe('');

    expect(conversationFileChangeEntries([item('change', 'file_change')])).toEqual([]);
  });

  it('Keep extra details available for otherwise ordinary items', () => {
    expect(
      conversationItemDetail('context_compaction', {
        summaryCode: 'CONTEXT_COMPACTED',
        reason: 'Context compressed'
      })
    ).toBe('Context compressed');
  });

  it('Keep reasoning collapsed by default, collapse on completion, and preserve user toggles', () => {
    expect(reasoningDisclosureOpen(undefined, true, undefined)).toBe(false);
    expect(reasoningDisclosureOpen(undefined, false, undefined)).toBe(false);
    expect(reasoningDisclosureOpen(true, true, false)).toBe(false);
    expect(reasoningDisclosureOpen(true, true, true)).toBe(true);
    expect(reasoningDisclosureOpen(true, false, true)).toBe(false);
    expect(reasoningDisclosureOpen(false, false, true)).toBe(true);
  });

  it('Preview the latest heading or paragraph first line without synthetic truncation', () => {
    expect(reasoningPreview('  First\nsummary  and another thought ')).toBe('First');
    expect(reasoningPreview('\n\n First\t summary  \r\nFurther reasoning\r\n')).toBe(
      'First summary'
    );
    expect(reasoningPreview('Old paragraph\r\n\r\n Latest summary\r\nFurther detail')).toBe(
      'Latest summary'
    );
    expect(reasoningPreview('  **Checking the implementation**\n\nFurther reasoning')).toBe(
      'Checking the implementation'
    );
    expect(reasoningPreview('**检查实现**\n正文继续')).toBe('检查实现');
    expect(reasoningPreview('** ** further reasoning')).toBe('** ** further reasoning');
    expect(reasoningPreview('**unfinished reasoning')).toBe('**unfinished reasoning');
    expect(reasoningPreview('Intro **emphasis** remains')).toBe('Intro **emphasis** remains');
    expect(reasoningPreview('First summary\n\nthen detailed thinking')).toBe(
      'then detailed thinking'
    );
    expect(
      reasoningPreview('**Inspecting source and logs**\n\n**Checking service logs**\n\nMore detail')
    ).toBe('Checking service logs');
    const longSummary = `${'word '.repeat(30)}following`;
    expect(reasoningPreview(`${longSummary}\nHidden detail`)).toBe(longSummary);
    expect(reasoningPreview(`**${longSummary}**\n\nFurther reasoning`)).toBe(longSummary);
    expect(reasoningPreview('思'.repeat(81))).toBe('思'.repeat(81));
    expect(reasoningPreview('🧠'.repeat(81))).toBe('🧠'.repeat(81));
    expect(reasoningPreview('Narrowing the search...')).toBe('Narrowing the search...');
    expect(reasoningPreview('Checking the context…')).toBe('Checking the context…');
    expect(reasoningPreview(' ')).toBe('');
  });

  it('Prefer an ordinary tool name over its native target title', () => {
    const payload = {
      namespace: 'opencode',
      toolName: 'read',
      title: 'docs/design/PROJECT_DESIGN.md'
    };

    expect(conversationItemLabel('tool_call', payload)).toBe(zhGeneratedPresentation.tool);
    expect(conversationItemText('tool_call', payload)).toBe('read');
    expect(conversationItemDetail('tool_call', payload)).toBe(
      `${zhPresentation.detail}${zhColon}docs/design/PROJECT_DESIGN.md`
    );
  });

  it.each([
    ['codex', 'exec'],
    ['mar-agent', 'code_exec_wait'],
    ['mar-agent', 'custom_tool']
  ])('shows %s.%s input and output using ordinary tool details', (namespace, toolName) => {
    const code =
      'const value = await tools.read({ reads: [{ path: "README.md" }] });\nout.text(value.content);';
    const input = toolName === 'code_exec_wait' ? '{"cellId":"cell-1","yieldMs":1500}' : code;
    const payload = {
      namespace,
      toolName,
      title: toolName,
      inputSummary: input,
      outputSummary: '# README'
    };
    expect(conversationItemText('tool_call', payload)).toBe(toolName);
    expect(conversationItemDetail('tool_call', payload)).toContain(
      `${zhPresentation.input}${zhColon}${input}`
    );
    expect(conversationItemDetail('tool_call', payload)).toContain('# README');
    localePreferenceService().setLocale('en-US');
    expect(conversationItemDetail('tool_call', payload)).toContain(
      `${enPresentation.input}: ${input}`
    );
    expect(conversationItemDetail('tool_call', payload)).toContain('# README');
  });

  it('shows a normalized Code Exec command with unchanged JavaScript and output in both locales', () => {
    const code =
      'const result = await tools.read({ reads: [{ path: "README.md" }] });\nout.text(result.content);';
    const payload = { command: code, outputPreview: '# README', cwd: null, exitCode: null };
    for (const locale of ['zh-CN', 'en-US'] as const) {
      localePreferenceService().setLocale(locale);
      expect(conversationItemText('command_execution', payload)).toBe(code);
      expect(conversationItemDetail('command_execution', payload)).toContain('# README');
      expect(
        conversationDisplayItems([item('code-cell', 'command_execution', payload)])[0]?.type
      ).toBe('command_group');
    }
  });

  it('shows hosted search input when it arrives on a running tool card', () => {
    const payload = {
      namespace: 'hosted-web',
      toolName: 'web_search',
      title: 'Web search',
      inputSummary: 'current news',
      progressLabel: 'Running'
    };
    expect(conversationItemDetail('tool_call', payload)).toContain(
      `${zhPresentation.input}${zhColon}current news`
    );
    localePreferenceService().setLocale('en-US');
    expect(conversationItemDetail('tool_call', payload)).toContain(
      `${enPresentation.input}: current news`
    );
  });

  it.each([
    ['mar-agent', 'agent_start'],
    ['mar-agent', 'agent_wait'],
    ['mar-agent', 'agent_cancel'],
    ['opencode', 'task'],
    ['claude-code', 'Agent'],
    ['claude-code', 'TaskOutput'],
    ['claude-code', 'TaskStop'],
    ['codex', 'spawn_agent'],
    ['codex', 'wait_agent'],
    ['codex', 'close_agent'],
    ['codex', 'resume_agent'],
    ['codex', 'send_input'],
    ['collaboration', 'spawn_agent'],
    ['collaboration', 'wait_agent'],
    ['multi_agent_v1', 'spawn_agent'],
    ['multi_agent_v2', 'interrupt_agent']
  ])('Do not infer subagent semantics from %s.%s', (namespace, toolName) => {
    const payload = { namespace, toolName, title: 'Inspect the implementation' };

    expect(conversationItemLabel('tool_call', payload)).toBe(zhGeneratedPresentation.tool);
    expect(conversationItemText('tool_call', payload)).toBe(toolName);
  });

  it('Do not mistake Claude task-list or ordinary tools for subagent tasks', () => {
    expect(
      conversationItemLabel('tool_call', {
        namespace: 'claude-code',
        toolName: 'Task',
        title: 'Task'
      })
    ).toBe(zhGeneratedPresentation.tool);
    expect(
      conversationItemLabel('tool_call', {
        namespace: 'codex',
        toolName: 'read',
        title: 'read'
      })
    ).toBe(zhGeneratedPresentation.tool);
  });

  it.each([
    [
      'START',
      'agent_start',
      `${zhPresentation.subagentOperation.START} Inspect the implementation`
    ],
    [
      'STATUS',
      'agent_wait',
      `${zhPresentation.subagentOperation.STATUS} Inspect the implementation`
    ],
    [
      'CANCEL',
      'agent_cancel',
      `${zhPresentation.subagentOperation.CANCEL} Inspect the implementation`
    ],
    [
      'MESSAGE',
      'send_message',
      `${zhPresentation.subagentOperation.MESSAGE} Inspect the implementation`
    ],
    [
      'RESUME',
      'resume_agent',
      `${zhPresentation.subagentOperation.RESUME} Inspect the implementation`
    ]
  ])('Render subagent actions with shared semantics: %s', (operation, toolName, expected) => {
    const payload = {
      namespace: 'mar-agent',
      toolName,
      title: 'Inspect the implementation',
      subagentOperation: operation,
      subagentId:
        toolName === 'agent_start'
          ? null
          : toolName === 'agent_wait' || toolName === 'agent_cancel'
            ? 'task-1'
            : 'worker-1'
    };

    expect(conversationItemLabel('tool_call', payload)).toBe(zhGeneratedPresentation.subagent);
    expect(conversationItemText('tool_call', payload)).toBe(expected);
  });

  it('Fall back to the subagent ID when a later action has no task title', () => {
    expect(
      conversationItemText('tool_call', {
        namespace: 'mar-agent',
        toolName: 'agent_wait',
        title: 'agent_wait',
        subagentOperation: 'STATUS',
        subagentId: 'task-1'
      })
    ).toBe(`${zhPresentation.subagentOperation.STATUS} task-1`);
  });

  it('groups subagent calls by identity at the last call without merging same-name tasks', () => {
    const call = (id: string, agentId: string | null, operation: string) =>
      item(id, 'tool_call', {
        toolName: 'control',
        title: 'Review',
        subagentId: agentId,
        subagentOperation: operation
      });
    const start = call('start', 'child-a', 'START');
    const wait = call('wait', 'child-a', 'STATUS');
    const display = conversationDisplayItems([
      start,
      call('other', 'child-b', 'START'),
      call('unknown', null, 'START'),
      call('many', null, 'STATUS'),
      wait,
      item('tool', 'tool_call', { toolName: 'read' })
    ]);
    expect(display.map(({ id }) => id)).toEqual(['other', 'unknown', 'many', 'start', 'tool']);
    expect(display[3]).toMatchObject({ type: 'subagent_group', id: 'start', items: [start, wait] });
    expect(subagentGroupText([start, wait])).toBe(
      `Review · ${zhPresentation.subagentOperation.STATUS}`
    );
    expect(conversationDisplayItems([start, { ...wait, status: 'FAILED' }])[0]?.id).toBe('start');
  });

  it('does not group subagent calls across assistant replies or compaction', () => {
    const call = (id: string) =>
      item(id, 'tool_call', { subagentOperation: 'STATUS', subagentId: 'child' });
    const display = conversationDisplayItems([
      call('a'),
      item('reply', 'assistant_message', { text: 'Progress' }),
      call('b'),
      item('compact', 'context_compaction'),
      call('c')
    ]);
    expect(display.filter((entry) => entry.type === 'subagent_group').map(({ id }) => id)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });

  it('joins a newly identified start and preserves a known title when later calls have only IDs', () => {
    const start = item('start', 'tool_call', {
      toolName: 'agent_start',
      title: 'Review',
      subagentOperation: 'START',
      subagentId: null
    });
    const wait = item('wait', 'tool_call', {
      toolName: 'agent_wait',
      title: 'agent_wait',
      subagentOperation: 'STATUS',
      subagentId: 'child'
    });
    expect(conversationDisplayItems([start, wait])).toHaveLength(2);
    const identified = { ...start, payload: { ...(start.payload as object), subagentId: 'child' } };
    expect(conversationDisplayItems([identified, wait])).toMatchObject([
      { type: 'subagent_group', id: 'start', items: [identified, wait] }
    ]);
    expect(subagentGroupText([identified, wait])).toBe(
      `Review · ${zhPresentation.subagentOperation.STATUS}`
    );
  });

  it.each(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'] as const)(
    'keeps subagent operation text independent of %s status',
    (status) => {
      const payload = { toolName: 'agent_start', title: 'Review', subagentOperation: 'START' };
      expect(conversationItemText('tool_call', payload, status)).toBe(
        `${zhPresentation.subagentOperation.START} Review`
      );
    }
  );

  it('uses only explicit normalized wait semantics', () => {
    expect(subagentOperationText({ subagentOperation: 'STATUS', subagentWait: true })).toBe(
      zhPresentation.subagentOperation.WAIT
    );
    expect(subagentOperationText({ subagentOperation: 'STATUS', toolName: 'agent_wait' })).toBe(
      zhPresentation.subagentOperation.STATUS
    );
  });

  it('uses invocation order rather than completion timing for the subagent group label', () => {
    const start = item('start', 'tool_call', {
      subagentOperation: 'START',
      subagentId: 'child',
      title: 'Review',
      toolName: 'agent_start'
    });
    const wait = item('wait', 'tool_call', {
      subagentOperation: 'STATUS',
      subagentWait: true,
      subagentId: 'child',
      title: 'agent_wait',
      toolName: 'agent_wait'
    });
    expect(subagentGroupText([start, wait])).toBe(
      `Review · ${zhPresentation.subagentOperation.WAIT}`
    );
    expect(subagentOperationText({ subagentOperation: 'STATUS', subagentWait: false })).toBe(
      zhPresentation.subagentOperation.STATUS
    );
    expect(subagentGroupText([start, { ...wait, status: 'FAILED' }])).toBe(
      subagentGroupText([start, wait])
    );
  });

  it('Keep subagent lifecycle operations separate from ordinary tool aggregation', () => {
    const displayItems = conversationDisplayItems([
      item('read-1', 'tool_call', { namespace: 'codex', toolName: 'read', title: 'read' }),
      item('status', 'tool_call', {
        namespace: 'codex',
        toolName: 'wait_agent',
        title: 'wait_agent',
        subagentOperation: 'STATUS',
        subagentId: 'worker-1'
      }),
      item('read-2', 'tool_call', { namespace: 'codex', toolName: 'read', title: 'read' })
    ]);

    expect(displayItems.map((entry) => entry.type)).toEqual(['subagent_group', 'tool_group']);
    expect(displayItems[1]).toMatchObject({
      type: 'tool_group',
      items: [{ id: 'read-1' }, { id: 'read-2' }]
    });
    expect(displayItems[0]).toMatchObject({ type: 'subagent_group', items: [{ id: 'status' }] });
  });

  it('Use only Node-normalized public fields for subagent titles', () => {
    expect(
      conversationItemText('tool_call', {
        namespace: 'claude-code',
        toolName: 'Agent',
        title: 'Troubleshoot authorization logic',
        subagentOperation: 'START',
        subagentId: null
      })
    ).toBe(`${zhPresentation.subagentOperation.START} Troubleshoot authorization logic`);
    expect(
      conversationItemText('tool_call', {
        namespace: 'collaboration',
        toolName: 'spawn_agent',
        title: 'review_oauth',
        subagentOperation: 'START',
        subagentId: null
      })
    ).toBe(`${zhPresentation.subagentOperation.START} review_oauth`);
  });

  it('Sub-Agent details show Node-normalized model and latest public message fields', () => {
    const detail = conversationItemDetail('tool_call', {
      namespace: 'opencode',
      toolName: 'task',
      title: 'Check implementation',
      subagentOperation: 'START',
      subagentId: 'ses_child',
      inputSummary: JSON.stringify({ subagent_type: 'explore', prompt: 'Check Resolve Link' }),
      outputSummary: 'Check Complete',
      subagentModelId: 'review',
      subagentModelName: 'Review Agent',
      subagentReasoningEffort: 'high',
      subagentLatestMessage: {
        itemId: 'message-1',
        turnId: 'turn-child-1',
        phase: 'commentary',
        text: 'Still checking.',
        timestamp: '2026-09-12T00:00:00.000Z',
        truncated: true
      }
    });

    expect(detail).toContain(
      `${zhPresentation.operation}${zhColon}${zhPresentation.subagentOperation.START}`
    );
    expect(detail).toContain(`${zhPresentation.subagentId}${zhColon}ses_child`);
    expect(detail).toContain(`${zhPresentation.task}${zhColon}Check implementation`);
    expect(detail).toContain(`${zhPresentation.model}${zhColon}Review Agent`);
    expect(detail).toContain(`${zhPresentation.modelId}${zhColon}review`);
    expect(detail).toContain(`${zhPresentation.reasoningEffort}${zhColon}high`);
    expect(detail).toContain(
      `${zhPresentation.messagePhase}${zhColon}${zhPresentation.subagentMessagePhase.commentary}`
    );
    expect(detail).toContain(`${zhPresentation.latestMessage}${zhColon}Still checking.`);
    expect(detail).toContain(`${zhPresentation.truncated}${zhColon}${zhPresentation.yes}`);
    expect(detail).toContain(
      `${zhPresentation.input}${zhColon}{"subagent_type":"explore","prompt":"Check Resolve Link"}`
    );
    expect(detail).toContain(`${zhPresentation.result}${zhColon}Check Complete`);
    expect(detail).not.toContain('<task');
  });

  it('The latest historical plan provides a direct implementation continuation even after the plan status has ended', () => {
    const plan = item('plan-latest', 'plan', { explanation: 'Embodiment' });
    expect(
      activePlanContinuation({
        item: plan,
        turns: [{ id: 'turn-plan', items: [plan] } as never],
        commandStates: [],
        steering: false,
        canStartTurn: true
      })
    ).toMatchObject({
      active: false,
      closeInput: null,
      continuation: {
        label: zhDomain.implement,
        prompt: zhDomain.implementThePlanAbove
      }
    });
  });

  it('Mar Agent task list displays friendly status labels by interface language and uses dedicated status colors', () => {
    const taskList = item('todo-latest', 'todo_list', {
      items: [
        { id: 'one', text: 'Check Existing Implementation', status: 'PENDING' },
        { id: 'two', text: 'Modify projection', status: 'IN_PROGRESS' },
        { id: 'three', text: 'Run Validation', status: 'COMPLETED' }
      ]
    });

    expect(conversationItemLabel(taskList.kind)).toBe(zhGeneratedPresentation.taskList);
    expect(conversationItemText(taskList.kind, taskList.payload)).toBe(
      zhGeneratedPresentation.taskListItems.replace('{value0}', '3')
    );
    expect(taskListItems(taskList.payload)).toEqual([
      {
        text: 'Check Existing Implementation',
        status: zhGeneratedPresentation.taskStatusTodo,
        tone: 'todo'
      },
      {
        text: 'Modify projection',
        status: zhGeneratedPresentation.taskStatusInProgress,
        tone: 'in-progress'
      },
      {
        text: 'Run Validation',
        status: zhGeneratedPresentation.taskStatusDone,
        tone: 'done'
      }
    ]);
    localePreferenceService().setLocale('en-US');
    expect(taskListItems(taskList.payload)).toEqual([
      { text: 'Check Existing Implementation', status: 'To-do', tone: 'todo' },
      { text: 'Modify projection', status: 'In progress', tone: 'in-progress' },
      { text: 'Run Validation', status: 'Done', tone: 'done' }
    ]);
    const timeline = readFileSync(
      resolve(process.cwd(), 'src/view/conversation/ConversationTimeline.vue'),
      'utf8'
    );
    expect(timeline).toContain('.task-list-status.task-list-status--todo');
    expect(timeline).toContain('.task-list-status.task-list-status--in-progress');
    expect(timeline).toContain('.task-list-status.task-list-status--done');
    expect(
      activePlanContinuation({
        item: taskList,
        turns: [{ id: 'turn-todo', items: [taskList] } as never],
        commandStates: [],
        steering: false,
        canStartTurn: true
      })
    ).toBeUndefined();
  });
});
