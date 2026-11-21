import type { ObjectDirective } from 'vue';
import {
  shouldAnimateSessionReorder,
  type SessionReorderSnapshot
} from '../../util/session-list.js';

interface MotionState {
  rendered: SessionReorderSnapshot;
  pending?: {
    previous: SessionReorderSnapshot;
    next: SessionReorderSnapshot;
    positions?: ReadonlyMap<string, number>;
  };
  animations: Set<Animation>;
  motionPreference: MediaQueryList;
  onMotionPreferenceChange: (event: MediaQueryListEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
}

const states = new WeakMap<HTMLElement, MotionState>();

function rows(element: HTMLElement, snapshot: SessionReorderSnapshot) {
  const children = Array.from(element.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('mar-session-reorder-item')
  );
  return snapshot.items.flatMap((item, index) => {
    const child = children[index];
    return child === undefined ? [] : [{ key: item.key, element: child }];
  });
}

function cancelAnimations(state: MotionState): void {
  for (const animation of state.animations) animation.cancel();
  state.animations.clear();
}

export const vSessionReorderMotion: ObjectDirective<HTMLElement, SessionReorderSnapshot> = {
  mounted(element, binding) {
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const state: MotionState = {
      rendered: binding.value,
      animations: new Set(),
      motionPreference,
      onMotionPreferenceChange(event) {
        if (event.matches) cancelAnimations(state);
      },
      onPointerDown(event) {
        const row = (event.target as Element).closest(
          '.mar-session-reorder-item[draggable="true"]'
        );
        if (event.button === 0 && row?.parentElement === element) cancelAnimations(state);
      }
    };
    motionPreference.addEventListener('change', state.onMotionPreferenceChange);
    element.addEventListener('pointerdown', state.onPointerDown, true);
    states.set(element, state);
  },
  beforeUpdate(element, binding) {
    const state = states.get(element);
    if (state === undefined) return;
    const layout = state.pending?.next ?? state.rendered;
    // Keep the original visual positions across multiple patches in the same Vue flush.
    const pending = (state.pending ??= { previous: state.rendered, next: binding.value });
    pending.next = binding.value;
    if (
      pending.positions !== undefined ||
      !shouldAnimateSessionReorder(pending.previous, pending.next) ||
      state.motionPreference.matches
    )
      return;

    const top = element.getBoundingClientRect().top;
    pending.positions = new Map(
      rows(element, layout).map((row) => [row.key, row.element.getBoundingClientRect().top - top])
    );
  },
  updated(element) {
    const state = states.get(element);
    if (state === undefined) return;
    const pending = state.pending;
    if (pending === undefined) return;
    delete state.pending;
    const { previous, next, positions } = pending;
    state.rendered = next;
    const reducedMotion = state.motionPreference.matches;
    if (!shouldAnimateSessionReorder(previous, next) || reducedMotion || positions === undefined) {
      const unchangedLayout =
        previous.ready &&
        next.ready &&
        previous.context === next.context &&
        previous.items.length === next.items.length &&
        previous.items.every(
          (item, index) =>
            item.key === next.items[index]?.key && item.pin === next.items[index]?.pin
        );
      if (!unchangedLayout || reducedMotion) cancelAnimations(state);
      return;
    }

    cancelAnimations(state);
    const top = element.getBoundingClientRect().top;
    const movements = rows(element, next).flatMap((row) => {
      const previousTop = positions.get(row.key);
      return previousTop === undefined
        ? []
        : [
            {
              element: row.element,
              delta: previousTop - (row.element.getBoundingClientRect().top - top)
            }
          ];
    });
    for (const movement of movements) {
      if (Math.abs(movement.delta) < 0.5) continue;
      const animation = movement.element.animate(
        [{ transform: `translateY(${movement.delta}px)` }, { transform: 'translateY(0px)' }],
        { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
      state.animations.add(animation);
      const finish = () => state.animations.delete(animation);
      void animation.finished.then(finish, finish);
    }
  },
  beforeUnmount(element) {
    const state = states.get(element);
    if (state === undefined) return;
    state.motionPreference.removeEventListener('change', state.onMotionPreferenceChange);
    element.removeEventListener('pointerdown', state.onPointerDown, true);
    cancelAnimations(state);
    states.delete(element);
  }
};
