import { describe, expect, it } from 'vitest';
import SkillDetailsDialog from '../../src/view/skill/SkillDetailsDialog.vue?unit-render';
import McpDetailsDialog from '../../src/view/skill/McpDetailsDialog.vue?unit-render';
import { renderComponent, textContent } from './support/component-renderer.js';

describe('catalog category presentation', () => {
  it.each([SkillDetailsDialog, McpDetailsDialog])(
    'keeps category labels neutral without changing featured emphasis',
    (component) => {
      const view = renderComponent(component, {
        modelValue: true,
        details: {
          name: 'Example',
          description: 'Example',
          featured: true,
          tags: ['tools', 'review']
        }
      });
      try {
        const tags = view.findAll('ElTag');
        expect(tags.map((tag) => tag.props['type'])).toEqual(['warning', 'info', 'info']);
        expect(tags.slice(1).map(textContent)).toEqual(['tools', 'review']);
      } finally {
        view.unmount();
      }
    }
  );
});
