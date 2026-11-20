import { defineComponent, h } from 'vue';

/** Keep component business tests independent of the browser's modal and focus implementation. */
export const MarDialog = defineComponent({
  props: { modelValue: Boolean },
  setup(props, { slots, attrs }) {
    return () =>
      props.modelValue
        ? h('MarDialog', { ...attrs, modelValue: props.modelValue }, [
            slots.header?.({ titleId: 'test-title', titleClass: '' }),
            slots.default?.(),
            slots.footer?.()
          ])
        : null;
  }
});
