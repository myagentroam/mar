import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Conversation composition boundary', () => {
  it('Ordinary and hosted conversations consume centrally gated history actions', () => {
    const timeline = readFileSync(
      resolve(process.cwd(), 'packages/web-core/src/view/conversation/ConversationTimeline.vue'),
      'utf8'
    );
    const surface = readFileSync(
      resolve(process.cwd(), 'packages/web-core/src/view/workbench/WorkbenchSurface.vue'),
      'utf8'
    );
    const controller = readFileSync(
      resolve(process.cwd(), 'packages/web-core/src/service/WorkbenchPageController.ts'),
      'utf8'
    );

    expect(timeline).toContain('readonly rewindEnabled: boolean;');
    expect(timeline.match(/v-if="props\.rewindEnabled && turn\.rewind"/gu)).toHaveLength(2);
    expect(timeline).toContain(
      'v-if="props.rollbackEnabled && turn.rewind && rollbackTarget(turn, displayItem.item)"'
    );
    expect(timeline).toContain('@click.stop="emit(\'rollback\', turn, displayItem.item)"');
    expect(timeline).toContain(
      "import { Back, Check, CopyDocument, RefreshLeft } from '@element-plus/icons-vue';"
    );
    expect(timeline).toContain('<el-icon><Back /></el-icon>');
    expect(timeline).not.toContain('<el-icon><DocumentDelete /></el-icon>');
    expect(timeline).not.toContain('<el-icon><Delete /></el-icon>');
    const rollbackButton = timeline.match(
      /<button\s+v-if="props\.rollbackEnabled[\s\S]*?<\/button>/u
    )?.[0];
    expect(rollbackButton).toContain(
      'class="conversation-message-action icon-button utility-control"'
    );
    expect(timeline).not.toContain('conversation-message-action--danger');
    expect(timeline.split("emit('rollback'").length - 1).toBe(1);
    expect(surface).toContain(':rewind-enabled="page.rewindConversationEnabled"');
    expect(surface).toContain(':rollback-enabled="page.rollbackConversationEnabled"');
    expect(surface).toContain('@rollback="page.rollbackConversation"');
    expect(controller).not.toContain("capabilities?.includes('session.rewind')");
  });
});
