<script setup lang="ts">
import { ElTag } from 'element-plus';
import { translate } from '../service/LocalePreferenceService.js';
import type { Component } from 'vue';

defineProps<{
  readonly authenticated: boolean;
  readonly logoUrl: string;
  readonly onlineNodeCount: number;
  readonly nodeCount: number;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly isAdmin: boolean;
  readonly serverVersion?: string;
  readonly extension?: Component;
}>();
const emit = defineEmits<{ extensionChanged: [] }>();
</script>

<template>
  <section class="system-information">
    <div
      class="system-brand"
      :aria-label="translate('generated.settingsContent.myAgentRoamVersion')"
    >
      <img :src="logoUrl" alt="" />
      <div>
        <strong>{{ translate('common.productName') }}</strong
        ><code>{{ serverVersion ?? translate('generated.settingsContent.unknown') }}</code>
      </div>
    </div>
    <section
      class="system-status"
      :aria-label="translate('generated.settingsContent.systemStatus')"
    >
      <h2>{{ translate('generated.settingsContent.systemStatus2') }}</h2>
      <dl>
        <div>
          <dt>{{ translate('common.webConsole') }}</dt>
          <dd>
            <el-tag effect="light" type="success">{{
              translate('generated.settingsContent.running')
            }}</el-tag>
          </dd>
        </div>
        <div>
          <dt>{{ translate('generated.settingsContent.serverConnection') }}</dt>
          <dd>
            <el-tag :type="authenticated ? 'success' : 'info'" effect="light">{{
              authenticated
                ? translate('generated.settingsContent.connected')
                : translate('generated.settingsContent.disconnected')
            }}</el-tag>
          </dd>
        </div>
        <div>
          <dt>{{ translate('generated.settingsContent.nodeConnections') }}</dt>
          <dd>
            <el-tag :type="onlineNodeCount > 0 ? 'success' : 'info'" effect="light"
              >{{ onlineNodeCount }}/{{ nodeCount }}</el-tag
            >
          </dd>
        </div>
      </dl>
    </section>
    <component
      :is="extension"
      v-if="isAdmin && extension"
      embedded
      :request="request"
      @imported="emit('extensionChanged')"
    />
  </section>
</template>

<style scoped>
.system-information {
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  padding: 20px 24px;
  background: var(--mar-bg-panel);
}
.system-brand {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--mar-border-subtle);
}
.system-brand img {
  width: 72px;
  height: 72px;
}
.system-brand div {
  display: grid;
  gap: 5px;
}
.system-brand strong {
  font-size: 24px;
  letter-spacing: -0.02em;
}
.system-brand code {
  color: var(--mar-text-muted);
  font-size: 12px;
}
.system-status {
  padding-top: 0.65rem;
}
.system-status h2 {
  margin-bottom: 0.55rem;
  font-size: var(--mar-font-size-body);
}
.system-status dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
  margin: 0;
}
.system-status dl > div {
  display: grid;
  gap: 0.25rem;
  border-bottom: 1px solid var(--mar-border-medium);
  padding: 0.5rem 0;
}
.system-status dt {
  color: var(--mar-text-muted);
}
.system-status dd {
  margin: 0;
}
@media (max-width: 767px) {
  .system-information {
    padding: 16px;
  }
  .system-status dl {
    grid-template-columns: 1fr;
  }
}
</style>
