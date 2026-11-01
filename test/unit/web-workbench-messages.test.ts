import { describe, expect, it } from 'vitest';
import { generatedEnUS } from '../../ee/web/src/i18n/messages.generated.en-US.js';
import { generatedZhCN } from '../../ee/web/src/i18n/messages.generated.zh-CN.js';
import {
  workbenchPageEnUS,
  workbenchPageZhCN
} from '../../packages/web-core/src/i18n/workbench-page.js';

describe('workbench controller messages', () => {
  it('publishes the complete authoritative message group in both locales', () => {
    expect(generatedEnUS.workbenchPageController).toEqual(
      workbenchPageEnUS.generated.workbenchPageController
    );
    expect(generatedZhCN.workbenchPageController).toEqual(
      workbenchPageZhCN.generated.workbenchPageController
    );
  });
});
