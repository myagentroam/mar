import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import MarIcon from '../../src/view/common/MarIcon.vue';
import { iconShapes, marIconSvg, type MarIconName } from '../../src/util/icon-shapes.js';
import { marIcon } from '../../src/util/mar-icons.js';
import ConversationRecordIcon from '../../src/view/conversation/ConversationRecordIcon.vue';

describe('shared MAR icons', () => {
  it.each(Object.keys(iconShapes) as MarIconName[])(
    'renders %s without an EL wrapper or fixed color',
    async (name) => {
      const html = await renderToString(createSSRApp(MarIcon, { name, size: 16 }));
      expect(html).toContain(`data-mar-icon="${name}"`);
      expect(html).toContain('width="16"');
      expect(html).toContain('height="16"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('focusable="false"');
      expect(html).not.toContain('el-icon');
      expect(html).not.toMatch(/(?:fill|stroke)="(?:#|rgb)/);
      expect(html.match(/<svg\b/g)).toHaveLength(1);
      expect(html).toContain(iconShapes[name]);
      expect(marIconSvg(name)).toContain(iconShapes[name]);
    }
  );

  it('reuses stable prop adapters without multiplying loading animation', async () => {
    expect(marIcon('search')).toBe(marIcon('search'));
    const html = await renderToString(createSSRApp(marIcon('loading-action'), { size: 20 }));
    expect(html).toContain('width="20"');
    expect(html).not.toContain('mar-icon--spinning');
    const direct = await renderToString(createSSRApp(MarIcon, { name: 'loading-action' }));
    expect(direct).toContain('mar-icon--spinning');
  });

  it('distinguishes the workspace, host and new conversation without changing button semantics', async () => {
    expect(iconShapes.workspace).not.toEqual(iconShapes.node);
    expect(iconShapes['session-add']).not.toEqual(iconShapes.conversation);
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(
            'button',
            {
              disabled: true,
              'aria-label': 'New session'
            },
            [h(MarIcon, { name: 'session-add' })]
          )
      })
    );
    expect(html).toContain('disabled');
    expect(html).toContain('aria-label="New session"');
    expect(html).toContain('data-mar-icon="session-add"');
  });

  it.each([
    ['READ', 'document'],
    ['WEB_SEARCH', 'search'],
    ['WEB_FETCH', 'web'],
    ['SKILL', 'skill'],
    ['SLEEP', 'clock'],
    ['command_execution', 'terminal'],
    ['file_change', 'file-change'],
    ['tool_call', 'tool']
  ] as const)('maps %s to the shared %s geometry', async (kind, name) => {
    const html = await renderToString(createSSRApp(ConversationRecordIcon, { kind }));
    expect(html).toContain(`data-mar-icon="${name}"`);
    expect(html).toContain(iconShapes[name]);
  });
});
