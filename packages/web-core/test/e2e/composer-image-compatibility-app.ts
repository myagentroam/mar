import { ref, watchEffect } from 'vue';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';

const output = document.querySelector<HTMLOutputElement>('#result')!;
const service = createComposerAttachmentService({
  context: () => ({ kind: 'workspace', nodeId: 'fixture', workspaceId: 'fixture' }),
  notice: () => {},
  request: async () => {
    throw new Error('Unexpected server fallback');
  },
  csrfToken: ref('fixture'),
  renewCsrfToken: async () => 'fixture',
  onUnauthenticated: () => {},
  direct: {
    generation: () => 'fixture',
    upload: async ({ descriptor, file }) => {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      output.value = JSON.stringify({
        name: file.name,
        mime: file.type,
        width: bitmap.width,
        height: bitmap.height,
        pixel: [...context.getImageData(0, 0, 1, 1).data],
        signature: [...new Uint8Array(await file.slice(0, 8).arrayBuffer())],
        descriptor
      });
      bitmap.close();
    }
  }
});

watchEffect(() => {
  const attachment = service.attachments.value[0];
  if (attachment?.status === 'FAILED') output.value = attachment.error ?? 'FAILED';
});
document.querySelector<HTMLInputElement>('#attachment')!.onchange = (event) => {
  service.clear();
  service.add((event.target as HTMLInputElement).files ?? []);
};
