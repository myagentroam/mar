import { createTooltipApp as createApp } from './tooltip-app.js';
import { h, ref, watch } from 'vue';
import { createWorkspaceUploadService } from '../../src/service/workspace-upload-service.js';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import { createWorkspaceDirectTransferService } from '../../src/service/workspace-direct-transfer-service.js';
import { createWorkbenchLiveService } from '../../src/service/workbench-live-service.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import WorkbenchActivityCenter from '../../src/view/workbench/WorkbenchActivityCenter.vue';
import type { WorkspaceTarget } from '../../src/model/workbench.js';
import type { DirectBrowserMessage, DirectServerMessage } from '../../../protocol/src/index.js';
import { createWorkbenchNodeConnectionService } from '../../src/service/workbench-node-connection-service.js';
import { createWorkspaceFileStreamClient } from '../../src/service/workspace-file-stream-client.js';
import { createWorkspaceFileAccessService } from '../../src/service/workspace-file-access-service.js';
import { createWorkspaceFilePreviewService } from '../../src/service/workspace-file-preview-service.js';
import { createScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createStandaloneWorkspaceDirectTransferService } from '../../src/service/standalone-workspace-direct-transfer-service.js';
import {
  readGitDirectFileMetadata,
  readWorkspaceDirectFileMetadata,
  readWorkspaceDirectFileRange
} from '../../src/service/workspace-direct-file-read-service.js';
import { workspaceFileSha256 } from '../../src/util/workspace-file-checksum.js';
import { unboundAccountStorage } from '../../src/service/account-storage-service.js';

const target = ref<WorkspaceTarget>();
const csrfToken = ref('');
const channels: RTCDataChannel[] = [];
const sent: DirectBrowserMessage[] = [];
const received: DirectServerMessage[] = [];
const progress: number[] = [];
let generation = '';
let liveReady = false;
let httpUploadCalls = 0;
let bodySignal: AbortSignal | undefined;
const notifications = createWorkbenchNotificationService(ref('upload-functional-user'));
const http = createScopedHttpService({ csrfToken: () => csrfToken.value });
const relay = createWorkbenchNodeConnectionService({ http });
const relayFiles = createWorkspaceFileStreamClient(relay.openStream);
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
  request(path, init) {
    if (path.includes('/uploads') && init?.method === 'PUT') httpUploadCalls++;
    return http.request(path, init);
  },
  onFilesChanged() {},
  onTaskChanged: notifications.recordUpload,
  sendBody: (input) => {
    bodySignal = input.signal;
    return fileClientForPath('direct').upload({
      ...input,
      onProgress(offset) {
        progress.push(offset);
        input.onProgress?.(offset);
      }
    });
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
      h(WorkbenchActivityCenter, {
        service: notifications,
        mobileMode: false,
        uploads: uploads.tasks.value,
        statusLabel: uploads.statusLabel,
        onRetryUpload: uploads.retry,
        onRemoveUpload: uploads.remove,
        onCancelUpload: uploads.cancel
      })
    ])
})
  .use(i18n)
  .mount('#app');

function fileClientForPath(path: 'direct' | 'relay') {
  if (path === 'relay') return relayFiles;
  return createWorkspaceFileStreamClient(async (targetNode, request, signal) => {
    if (request.kind !== 'file-upload' && request.kind !== 'file-download')
      throw new Error('Unexpected non-Workspace stream');
    const stream = await direct.openFileStream(targetNode, generation, request.descriptor, signal);
    if (stream === undefined) throw new Error('Expected the existing ICE carrier');
    return stream;
  });
}

async function inspectPreview<T>(
  path: 'direct' | 'relay',
  fileName: string,
  commit: string | undefined,
  inspect: (content: string, url: string | undefined) => T | Promise<T>
): Promise<T> {
  const isImage = fileName.endsWith('.png');
  const access = createWorkspaceFileAccessService({
    request: http.request,
    http: {
      request: (url, init) => {
        if (url.includes('/files/read?')) throw new Error('Unexpected HTTP file body');
        return http.request(url, init);
      }
    },
    fetchContent: async (url, init) => {
      if (isImage) return fetch(url, init);
      throw new Error('Unexpected HTTP content URL');
    },
    manifest: () => undefined,
    available: () => false,
    direct,
    downloads: isImage
      ? {
          async download() {
            throw new Error('Image preview must not open a file stream');
          }
        }
      : fileClientForPath(path)
  });
  const preview = createWorkspaceFilePreviewService({
    access: access.forWorkspace,
    onWritten() {}
  });
  try {
    const result = await preview.open(1, {
      ...target.value!,
      path: fileName,
      ...(commit === undefined
        ? {}
        : {
            history: { commit, repositoryPath: '', refs: ['refs/heads/main'] }
          })
    });
    if (result === undefined) throw preview.page(1).error.value;
    return await inspect(result.content, preview.page(1).contentUrl.value);
  } finally {
    preview.close(1);
  }
}

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
  previewText(path: 'direct' | 'relay', commit?: string) {
    return inspectPreview(path, 'history.txt', commit, (content) => content);
  },
  previewImage(commit?: string) {
    return inspectPreview('relay', 'history.png', commit, async (_, url) => {
      if (!url?.startsWith('/api/workspaces/')) throw new Error('Expected an HTTP image preview');
      const element = new Image();
      element.src = url;
      await element.decode();
      const bytes = [...new Uint8Array(await (await fetch(url)).arrayBuffer())];
      return { bytes, width: element.naturalWidth };
    });
  },
  downloadToBrowser(path: string, commit?: string) {
    const access = createWorkspaceFileAccessService({
      request: http.request,
      http,
      manifest: () => undefined,
      available: () => false,
      direct,
      downloads: relayFiles
    }).forWorkspace(target.value!);
    return commit === undefined
      ? access.directFileDownload(path)
      : access.directGitFileDownload(commit, path, '', ['refs/heads/main']);
  },
  async roundTripFromStandalone(path: string) {
    const { nodeId, workspaceId } = target.value!;
    const standalone = createStandaloneWorkspaceDirectTransferService({
      nodeId,
      workspaceId,
      http
    });
    try {
      const preview = await standalone.readRange(path, 0, 16);
      return { preview: [...preview.bytes], download: await standalone.download(path) };
    } finally {
      standalone.close();
    }
  },
  async readGitRange(commit: string, refs: string[]) {
    const { nodeId, workspaceId } = target.value!;
    const resource = { kind: 'GIT_COMMIT_BLOB' as const, workspaceId, path: 'history.bin', commit };
    const result = await readWorkspaceDirectFileRange({
      nodeId,
      nodeGeneration: generation,
      fileName: 'history.bin',
      resource: { ...resource, refs },
      direct: relayFiles,
      metadata: () =>
        readGitDirectFileMetadata({
          request: http.request,
          nodeId,
          resource,
          refs: ['refs/heads/main']
        }),
      offset: 524_319,
      length: 83
    });
    return [...result.bytes];
  },
  async fileRoundtrip(path: 'direct' | 'relay') {
    const { nodeId, workspaceId } = target.value!;
    const files = fileClientForPath(path);
    const resource = { kind: 'WORKSPACE_FILE', workspaceId, path: 'resumed.bin' } as const;
    const identity = await readWorkspaceDirectFileMetadata({
      request: http.request,
      nodeId,
      resource
    });
    if (identity === undefined) throw new Error('Expected file metadata');
    async function download(offset: number, length: number) {
      let received = 0;
      const output = new Uint8Array(length);
      await files.download({
        nodeId,
        descriptor: {
          direction: 'DOWNLOAD',
          resource,
          fileName: 'resumed.bin',
          ...identity!,
          range: { offset, length }
        },
        sink: {
          async write(bytes) {
            if (received === 0) await new Promise((resolve) => setTimeout(resolve, 50));
            output.set(bytes, received);
            received += bytes.length;
          },
          async close() {},
          async abort() {
            throw new Error('Download aborted');
          }
        }
      });
      return output;
    }
    const [head, tail] = await Promise.all([
      download(17, identity.size - 32),
      download(identity.size - 13, 13)
    ]);
    const file = new File([head], `${path}-staged.bin`);
    const sha256 = await workspaceFileSha256(file);
    const calls: string[] = [];
    const stagedUploads = createWorkspaceUploadService({
      storage: unboundAccountStorage,
      workspaceTarget: target,
      request: (path, init) => {
        calls.push(path);
        return http.request(path, init);
      },
      sendBody: files.upload,
      onFilesChanged() {}
    });
    try {
      stagedUploads.queue([{ file, directory: '.', overwrite: false }]);
      await new Promise<void>((resolve, reject) => {
        const stop = watch(
          () => stagedUploads.tasks.value[0]?.status,
          (status) => {
            if (status !== 'FAILED' && status !== 'COMPLETED') return;
            stop();
            if (status === 'COMPLETED') resolve();
            else reject(new Error(stagedUploads.tasks.value[0]?.error));
          }
        );
      });
    } finally {
      stagedUploads.dispose();
    }
    return { sha256, tail: [...tail], calls };
  },
  async uploadComposerAttachment(path: 'direct' | 'relay', save = false) {
    const { nodeId, workspaceId } = target.value!;
    const file = new File(['composer stream bytes\n'], 'composer.txt', { type: 'text/plain' });
    const calls: string[] = [];
    const attachments = createComposerAttachmentService({
      context: () => ({ kind: 'workspace', nodeId, workspaceId }),

      notice() {},
      request: (path, init) => {
        calls.push(path);
        return http.request(path, init);
      },
      sendBody: fileClientForPath(path).upload
    });
    attachments.add([file]);
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = watch(
          () => attachments.attachments.value[0]?.status,
          (status) => {
            if (status !== 'FAILED' && status !== 'COMPLETED') return;
            stop();
            if (status === 'COMPLETED') resolve();
            else reject(new Error(attachments.attachments.value[0]?.error));
          }
        );
      });
      const { id, receivedBytes } = attachments.attachments.value[0]!;
      const resource = `mar-attachment://${id}/${file.name}`;
      if (save && (await harness.downloadToBrowser(resource)) !== 'COMPLETED')
        throw new Error('Expected the private attachment download to complete');
      const body = await inspectPreview(path, resource, undefined, (content) => content);
      return { receivedBytes, body, uploadCalls: [...calls] };
    } finally {
      attachments.clear();
    }
  },
  interrupt: () =>
    channels
      .filter((channel) => channel.label === 'mar-node-stream' && channel.readyState === 'open')
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
    channels: channels.map((channel) => channel.label),
    httpUploadCalls,
    bodyAborted: bodySignal?.aborted === true
  }),
  dispose() {
    relay.reset();
    uploads.dispose();
    direct.close();
    live.close();
    notifications.dispose();
  }
};
Object.assign(window, { uploadFlow: harness });
