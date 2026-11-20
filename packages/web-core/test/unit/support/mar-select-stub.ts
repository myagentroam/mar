import { defineComponent, h } from 'vue';

// Business fixtures drive the model and slots at the control boundary. Chromium tests own
// filtering, navigation and the relationship between DOM options and selected values.
export const MarSelect = defineComponent({
  name: 'MarSelect',
  inheritAttrs: false,
  props: ['modelValue'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('MarSelect', { ...attrs, modelValue: props.modelValue }, slots.default?.())
});

export const MarOption = defineComponent({
  name: 'MarOption',
  inheritAttrs: false,
  setup:
    (_, { attrs, slots }) =>
    () =>
      h('MarOption', attrs, slots.default?.())
});
