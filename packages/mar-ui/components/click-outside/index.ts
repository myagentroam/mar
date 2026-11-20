import type { Directive } from 'vue';

const bindings = new WeakMap<
  HTMLElement,
  { abort: AbortController; handler: () => void; except?: HTMLElement | undefined }
>();

/** Dismisses only after a pointer gesture starts and ends outside both owned surfaces. */
export const vClickOutside: Directive<HTMLElement, () => void> = {
  mounted(element, binding) {
    const state = {
      abort: new AbortController(),
      handler: binding.value,
      except: binding.arg as unknown as HTMLElement | undefined
    };
    bindings.set(element, state);
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      return !path.includes(element) && (!state.except || !path.includes(state.except));
    };
    let pointer: number | undefined;
    const options = { capture: true, signal: state.abort.signal };
    element.ownerDocument.addEventListener(
      'pointerdown',
      (event) => {
        pointer = outside(event) ? event.pointerId : undefined;
      },
      options
    );
    element.ownerDocument.addEventListener(
      'pointerup',
      (event) => {
        if (pointer === event.pointerId && outside(event)) state.handler();
        pointer = undefined;
      },
      options
    );
    element.ownerDocument.addEventListener(
      'pointercancel',
      () => {
        pointer = undefined;
      },
      options
    );
  },
  updated(element, binding) {
    const state = bindings.get(element);
    if (!state) return;
    state.handler = binding.value;
    state.except = binding.arg as unknown as HTMLElement | undefined;
  },
  beforeUnmount(element) {
    bindings.get(element)?.abort.abort();
    bindings.delete(element);
  }
};
