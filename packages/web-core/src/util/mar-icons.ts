import { defineComponent, h, markRaw, type Component, type PropType } from 'vue';
import { iconShapes, type MarIconName } from './icon-shapes.js';

/** Pure SVG renderer shared by templates and service-created controls. */
export const MarIconGraphic = defineComponent({
  name: 'MarIconGraphic',
  props: {
    name: { type: String as PropType<MarIconName>, required: true },
    size: { type: [Number, String], default: '1em' }
  },
  setup: (props) => () =>
    h('svg', {
      class: 'mar-icon',
      'data-mar-icon': props.name,
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: '0 0 24 24',
      width: props.size,
      height: props.size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.75,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      innerHTML: iconShapes[props.name]
    })
});

const components = new Map<MarIconName, Component>();

/** Stable adapters for controls that accept an icon component rather than a slot. */
export function marIcon(name: MarIconName): Component {
  let component = components.get(name);
  if (component === undefined) {
    component = markRaw(
      defineComponent({
        name: `MarIcon-${name}`,
        inheritAttrs: false,
        // Element Plus owns the loading-icon container animation.
        setup:
          (_, { attrs }) =>
          () =>
            h(MarIconGraphic, { ...attrs, name })
      })
    );
    components.set(name, component);
  }
  return component;
}
