// Track native opening order, which can differ from DOM order and does not depend on focus.
const layers = new WeakMap<Document, Set<HTMLDialogElement>>();

export function openModal(dialog: HTMLDialogElement): void {
  dialog.showModal();
  let stack = layers.get(dialog.ownerDocument);
  if (!stack) layers.set(dialog.ownerDocument, (stack = new Set()));
  // A modal restored after a native close re-enters at the top.
  stack.delete(dialog);
  stack.add(dialog);
}

export function closeModal(dialog: HTMLDialogElement): void {
  layers.get(dialog.ownerDocument)?.delete(dialog);
  dialog.close();
}

export function getActiveMarDialog(document: Document): HTMLDialogElement | undefined {
  return Array.from(layers.get(document) ?? []).findLast(
    (dialog) => dialog.isConnected && dialog.open && !dialog.hasAttribute('data-closing')
  );
}
