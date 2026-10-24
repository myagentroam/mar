import { type ComponentInternalInstance, type VNode } from 'vue';
import { createMobileLayerHistoryService } from './MobileLayerHistoryService.js';

const dialogs = new WeakMap<
  ComponentInternalInstance,
  ReturnType<typeof createMobileLayerHistoryService>
>();

/** Explicit component lifecycle hooks; close through Dialog's public handleClose. */
export function mountMobileDialogReturn(vnode: VNode): void {
  const instance = vnode.component;
  if (instance === null || dialogs.has(instance)) return;
  const dialog = instance.exposed as { handleClose(): void } | null;
  if (dialog === null) return;
  const service = createMobileLayerHistoryService({
    isOpen: () => instance.props.modelValue === true,
    close: () => dialog.handleClose()
  });
  dialogs.set(instance, service);
  service.start();
}

export function unmountMobileDialogReturn(vnode: VNode): void {
  if (vnode.component === null) return;
  dialogs.get(vnode.component)?.dispose();
  dialogs.delete(vnode.component);
}
