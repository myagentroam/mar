import { createTooltipApp as createApp } from './tooltip-app.js';
import { h, ref } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import { createWorkspaceUploadService } from '../../src/service/workspace-upload-service.js';
import { createWorkspaceDirectTransferService } from '../../src/service/workspace-direct-transfer-service.js';
import { createWorkbenchLiveService } from '../../src/service/workbench-live-service.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import WorkbenchNotificationCenter from '../../src/view/workbench/WorkbenchNotificationCenter.vue';
import type { WorkspaceTarget } from '../../src/model/workbench.js';
import type { DirectBrowserMessage, DirectServerMessage } from '../../../protocol/src/index.js';

const target = ref<WorkspaceTarget>();
const csrfToken = ref('');
const channels: RTCDataChannel[] = [];
const sent: DirectBrowserMessage[] = [];
const received: DirectServerMessage[] = [];
const progress: number[] = [];
let generation = '';
let liveReady = false;
let httpUploadCalls = 0;
const notifications = createWorkbenchNotificationService(ref('upload-functional-user'));
const direct = createWorkspaceDirectTransferService({
  send(message) {
    sent.push(message);
    return live.sendDirect(message);
  },
  createPeerConnection() {
    const peer = new RTCPeerConnection({ iceServers: [] });
    const createChannel = peer.createDataChannel.bind(peer);
    peer.createDataChannel = (...args) => {
      const channel = createChannel(...args);
      channels.push(channel);
      return channel;
    };
    return peer;
  }
});
const live = createWorkbenchLiveService({
  canConnect: () => true,
  onEvent() {},
  onResyncRequired() {},
  onNodeConnection() {},
  onNodeReplaced() {},
  onReconnect() {},
  onUnauthenticated() {},
  onInvalidMessage() {},
  onReady() {
    liveReady = true;
  },
  onDirectMessage(message) {
    received.push(message);
    direct.handle(message);
  }
});
const uploads = createWorkspaceUploadService({
  workspaceTarget: target,
  csrfToken,
  request: async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (path.includes('/uploads')) httpUploadCalls++;
    const response = await fetch(path, {
      ...init,
      headers: { 'x-csrf-token': csrfToken.value, 'content-type': 'application/json' }
    });
    if (!response.ok) throw new Error('REQUEST_FAILED');
    return (await response.json()) as T;
  },
  renewCsrfToken: async () => csrfToken.value,
  onFilesChanged() {},
  onTaskChanged: notifications.recordUpload,
  direct: {
    generation: () => generation,
    upload: (input) =>
      direct.upload({
        ...input,
        onProgress(offset) {
          progress.push(offset);
          input.onProgress(offset);
        }
      })
  }
});
localePreferenceService().setLocale('en-US');
createApp({
  setup: () => () =>
    h('main', [
      h('label', [
        'Upload source',
        h('input', {
          type: 'file',
          'aria-label': 'Upload source',
          onChange(event: Event) {
            const file = (event.target as HTMLInputElement).files?.[0];
            if (file) uploads.queue([{ file, directory: '.', overwrite: false }]);
          }
        })
      ]),
      h('input', {
        type: 'file',
        'aria-label': 'Recovery source',
        ref: uploads.recoveryInput,
        onChange: uploads.recover
      }),
      h(WorkbenchNotificationCenter, {
        service: notifications,
        uploads: uploads.tasks.value,
        statusLabel: uploads.statusLabel,
        onRetryUpload: uploads.retry,
        onRemoveUpload: uploads.remove,
        onCancelUpload: uploads.cancel
      })
    ])
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');

export const harness = {
  async initialize(input: WorkspaceTarget & { generation: string; csrfToken: string }) {
    target.value = input;
    generation = input.generation;
    csrfToken.value = input.csrfToken;
    uploads.restore();
    live.connect();
  },
  ready: () => liveReady,
  connect: () => direct.ensureTransport(target.value!.nodeId, generation),
  interrupt: () =>
    channels
      .filter(
        (channel) => channel.label !== 'mar-direct-transport' && channel.readyState === 'open'
      )
      .forEach((channel) => channel.close()),
  snapshot: () => ({
    tasks: uploads.tasks.value.map(({ file: _file, ...task }) => task),
    prepares: sent.filter((message) => message.type === 'direct.prepare'),
    grants: received
      .filter((message) => message.type === 'direct.grant')
      .map((message) => message.directSessionId),
    completed: received
      .filter((message) => message.type === 'direct.complete')
      .map((message) => message.directSessionId),
    progress: [...progress],
    httpUploadCalls
  }),
  dispose() {
    uploads.dispose();
    direct.close();
    live.close();
    notifications.dispose();
  }
};
Object.assign(window, { uploadFlow: harness });
