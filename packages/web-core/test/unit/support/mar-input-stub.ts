import { defineComponent, h } from 'vue';

// Business component tests drive the control's public contract; Chromium covers native input.
export const MarInput = defineComponent({
  name: 'MarInput',
  inheritAttrs: false,
  props: ['modelValue'],
  setup(props, { attrs, slots }) {
    return () =>
      h(
        'MarInput',
        { ...attrs, modelValue: props.modelValue },
        Object.entries(slots).map(([name, slot]) =>
          name === 'password-icon' ? slot?.({ visible: false }) : slot?.()
        )
      );
  }
});
