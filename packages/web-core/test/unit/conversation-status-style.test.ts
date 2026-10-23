import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) =>
  readFileSync(new URL(`../../src/view/${path}.vue`, import.meta.url), 'utf8');

describe('conversation status styling', () => {
  it('keeps the composer spinner compact without relying on shared style order', () => {
    const composer = source('composer/ConversationComposer');
    expect(composer).toContain('class="composer-busy-indicator"');
    expect(composer).toMatch(
      /\.composer-working > \.composer-busy-indicator\s*\{\s*width: 10px;\s*height: 10px;\s*border-width: 1\.5px;/u
    );
  });

  it('emphasizes the active label neutrally and reserves brand color for the indicator', () => {
    const process = source('conversation/ConversationWorkProcess');
    expect(process).toMatch(
      /\.process-activity\.is-active\s*\{\s*color: var\(--mar-conversation-text\);\s*font-weight: 600;\s*\}/u
    );
    expect(process).toMatch(
      /\.process-activity-indicator\s*\{\s*color: var\(--mar-color-brand-text\);/u
    );
  });

  it('uses the shared trailing group metadata for file counts', () => {
    const timeline = source('conversation/ConversationTimeline');
    expect(timeline).toMatch(
      /conversationItemLabel\('file_change'\)[\s\S]*?<span class="conversation-group-meta"[\s\S]*?conversationFileChangeEntries\(displayItem.items\)\.length/u
    );
    expect(timeline).toMatch(
      /summary\.conversation-record-heading > \.conversation-group-meta\s*\{\s*flex: none;\s*margin-inline-start: auto;/u
    );
  });

  it('keeps the plan item count in the same trailing metadata position', () => {
    const timeline = source('conversation/ConversationTimeline');
    expect(timeline).toMatch(
      /v-if="planSteps\(displayItem\.item\.payload\)\.length"\s+class="conversation-record-meta"/u
    );
  });
});
