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

  it('keeps action spokes uniformly opaque during whole-icon rotation', async () => {
    const html = await renderToString(createSSRApp(MarIcon, { name: 'loading-action' }));
    const paths = Array.from(html.matchAll(/<path\b[^>]*>/g), (match) => match[0]);
    expect(paths).toHaveLength(8);
    for (const path of paths) {
      const opacity = path.match(/\bopacity="([^"]+)"/)?.[1] ?? '1';
      expect(Number(opacity)).toBe(1);
    }
    expect(html).toContain('stroke-linecap="round"');
    expect(html).not.toMatch(/<(?:animate|animateTransform|set)\b/);
  });

  it('keeps the reasoning marker static and distinct from the model and loading icons', async () => {
    const html = await renderToString(createSSRApp(MarIcon, { name: 'reasoning', size: 18 }));
    expect(html).toContain('fill="none"');
    expect(html).not.toContain('mar-icon--spinning');
    expect(html).not.toMatch(/<(?:animate|animateTransform|set)\b/);
    expect(iconShapes.reasoning).not.toEqual(iconShapes.model);
    expect(iconShapes.reasoning).not.toEqual(iconShapes['loading-action']);
    expect(iconShapes.reasoning).not.toEqual(iconShapes['loading-content']);
  });

  it('distinguishes administration from personal settings and inline adjustments', () => {
    expect(iconShapes.administration).not.toEqual(iconShapes.settings);
    expect(iconShapes.administration).not.toEqual(iconShapes.adjustments);
  });

  it('distinguishes the session hierarchy from collections and copying', () => {
    expect(iconShapes['session-tree']).toEqual(expect.any(String));
    expect(iconShapes['session-tree']).not.toEqual(iconShapes.collection);
    expect(iconShapes['session-tree']).not.toEqual(iconShapes.copy);
  });

  it('renders a separate back card behind the recent-session content strokes', async () => {
    const html = await renderToString(createSSRApp(MarIcon, { name: 'recent-sessions', size: 24 }));
    expect(html.match(/<rect\b/g)).toHaveLength(1);
    expect(html.match(/<path\b/g)).toHaveLength(2);
    expect(html).not.toContain('mar-icon--spinning');
  });

  it('keeps a disconnected Node distinct from connection actions', async () => {
    expect(iconShapes['connection-off']).toEqual(expect.any(String));
    expect(iconShapes['connection-off']).not.toEqual(iconShapes.connection);
    expect(iconShapes['connection-off']).not.toEqual(iconShapes.link);
    const html = await renderToString(createSSRApp(MarIcon, { name: 'connection-off', size: 28 }));
    expect(html).toContain('data-mar-icon="connection-off"');
    expect(html).not.toContain('mar-icon--spinning');
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
    ['reasoning', 'reasoning'],
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
