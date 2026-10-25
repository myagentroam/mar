<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { CUSTOM_THEME_TOKENS } from '../../model/custom-theme.js';
import { THEME_TOKEN_GROUPS, THEME_TOKEN_HELP } from '../../model/theme-token-help.js';

defineProps<{ colors: Record<string, string> }>();
const { t } = useI18n();
const open = ref(false);
const search = ref('');
const groups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return THEME_TOKEN_GROUPS.map((group) => ({
    key: group,
    label: t('customThemes.tokenGroups.' + group),
    tokens: CUSTOM_THEME_TOKENS.filter((token) => THEME_TOKEN_HELP[token].group === group)
      .map((token) => ({
        token,
        description: t('customThemes.tokenDescriptions.' + THEME_TOKEN_HELP[token].description)
      }))
      .filter((item) => (item.token + ' ' + item.description).toLocaleLowerCase().includes(query))
  })).filter((group) => group.tokens.length);
});
function show(): void {
  search.value = '';
  open.value = true;
}
async function copy(token: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(token);
    showMessage(t('customThemes.tokenCopied'), 'info');
  } catch {
    showMessage(t('customThemes.tokenCopyFailed'), 'error');
  }
}
</script>

<template>
  <el-button
    v-tooltip="t('customThemes.tokenHelp')"
    class="utility-control"
    text
    :icon="marIcon('help')"
    :aria-label="t('customThemes.tokenHelp')"
    @click="show"
  />
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="open"
    v-model="open"
    :title="t('customThemes.tokenHelp')"
    width="min(720px, calc(100vw - 32px))"
    append-to-body
    class="theme-token-help"
    :close-icon="marIcon('close')"
  >
    <p class="hint">{{ t('customThemes.tokenHint') }}</p>
    <el-input
      v-model="search"
      :prefix-icon="marIcon('search')"
      :placeholder="t('customThemes.tokenSearch')"
      :aria-label="t('customThemes.tokenSearch')"
      clearable
      :clear-icon="marIcon('clear-input')"
    />
    <div class="reference-body">
      <section v-for="group in groups" :key="group.key">
        <h3>{{ group.label }}</h3>
        <dl>
          <div v-for="item in group.tokens" :key="item.token" class="token-row">
            <dt>
              <span
                class="swatch"
                :style="{ backgroundColor: colors[item.token] }"
                aria-hidden="true"
              />
              <code>{{ item.token }}</code>
              <el-button
                v-tooltip="t('customThemes.tokenCopy', { token: item.token })"
                class="utility-control"
                link
                :icon="marIcon('copy')"
                :aria-label="t('customThemes.tokenCopy', { token: item.token })"
                @click="copy(item.token)"
              />
            </dt>
            <dd>{{ item.description }}</dd>
          </div>
        </dl>
      </section>
      <p v-if="!groups.length" class="hint">{{ t('customThemes.tokenEmpty') }}</p>
    </div>
  </el-dialog>
</template>

<style scoped>
.hint {
  margin: 0 0 0.75rem;
  color: var(--mar-text-secondary);
  line-height: 1.6;
}
.reference-body {
  margin-top: 0.75rem;
}
h3 {
  margin: 1rem 0 0.25rem;
  font-size: var(--mar-font-size-title);
}
dl {
  margin: 0;
}
.token-row {
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--mar-border-subtle);
}
dt {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
code {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-body);
}
dd {
  margin: 0.25rem 0 0 1.5rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
}
.swatch {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  border: 1px solid var(--mar-border-default);
  border-radius: 3px;
}
</style>
