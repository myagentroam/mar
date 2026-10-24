import {
  createRenderer,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  ssrContextKey,
  type Component,
  type InjectionKey
} from 'vue';
import { i18n } from '../../../src/service/locale-preference-service.js';

export interface TestElement {
  type: string;
  text: string;
  props: Record<string, unknown>;
  style: Record<string, string>;
  parent: TestElement | null;
  children: TestElement[];
  addEventListener(): void;
  getRootNode(): null;
}

function element(type: string, text = ''): TestElement {
  return {
    type,
    text,
    props: {},
    style: {},
    parent: null,
    children: [],
    addEventListener() {},
    getRootNode: () => null
  };
}

// Execute the real template and lifecycle without a browser. Element Plus controls
// are dependency stubs; layout, focus and control validation belong in Chromium.
export function renderComponent(
  component: Component,
  props: object = {},
  slots: Record<string, unknown> = {},
  options: { validate?: () => Promise<boolean> } = {}
) {
  const renderer = createRenderer<TestElement, TestElement>({
    createElement: (tag) => element(tag),
    createText: (text) => element('#text', text),
    createComment: (text) => element('#comment', text),
    setText: (node, text) => {
      node.text = text;
    },
    setElementText: (node, text) => {
      for (const child of node.children) child.parent = null;
      node.text = text;
      node.children = [];
    },
    patchProp: (node, key, _previous, value) => {
      node.props[key] = value;
    },
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null
  });
  const app = renderer.createApp({ render: () => h(component, props, slots) });
  app.use(i18n);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.directive('loading', {});
  // Browser fixtures cover delegated tooltip events and real DOM positioning.
  app.directive('tooltip', {});
  const rowsKey: InjectionKey<() => Record<string, unknown>[]> = Symbol('table rows');
  for (const name of [
    'ElButton',
    'ElIcon',
    'ElInput',
    'ElInputNumber',
    'ElSelect',
    'ElOption',
    'ElFormItem',
    'ElTag',
    'ElCheckTag',
    'ElSwitch',
    'ElTooltip',
    'ElEmpty',
    'ElDescriptions',
    'ElDescriptionsItem',
    'ElTabs',
    'ElTabPane',
    'ElPagination',
    'ElDatePicker',
    'ElAlert',
    'ElCheckbox',
    'ElProgress',
    'ElLink',
    'ElRadioGroup',
    'ElRadioButton',
    'ElRadio',
    'ElDivider',
    'ElTable',
    'ElTableColumn',
    'ElDialog',
    'ElForm',
    'ElPopover'
  ]) {
    app.component(
      name,
      defineComponent({
        inheritAttrs: false,
        props: ['modelValue', 'data', 'prop'],
        setup(controlProps, { attrs, slots: controlSlots, expose }) {
          if (name === 'ElTable')
            provide(rowsKey, () => controlProps.data as Record<string, unknown>[]);
          const rows = name === 'ElTableColumn' ? inject(rowsKey)! : undefined;
          if (name === 'ElForm')
            expose({
              validate: options.validate ?? (async () => true),
              validateField: async () => undefined,
              clearValidate() {}
            });
          return () => {
            if (name === 'ElDialog' && !controlProps.modelValue) return null;
            const children = rows
              ? rows().map(
                  (row) =>
                    controlSlots.default?.({ row }) ?? String(row[String(controlProps.prop)] ?? '')
                )
              : Object.entries(controlSlots).map(([slotName, slot]) =>
                  name === 'ElInput' && slotName === 'password-icon'
                    ? slot?.({ visible: false })
                    : slot?.()
                );
            return h(name, { ...attrs, ...controlProps }, children);
          };
        }
      })
    );
  }
  const root = element('root');
  app.mount(root);
  function findAll(type: string): TestElement[] {
    const visit = (node: TestElement): TestElement[] => [
      ...(node.type === type ? [node] : []),
      ...node.children.flatMap(visit)
    ];
    return visit(root);
  }
  return { root, findAll, unmount: () => app.unmount() };
}

export function textContent(node: TestElement): string {
  return node.type === '#comment' ? '' : node.text + node.children.map(textContent).join('');
}

export async function flushComponent(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await nextTick();
}

export async function trigger(node: TestElement, event: string, ...args: unknown[]): Promise<void> {
  if (!node) throw new Error(`Missing control for ${event}`);
  const handler = node.props[event];
  if (typeof handler !== 'function') throw new Error(`Missing ${event} on ${node.type}`);
  await handler(...args);
  await flushComponent();
}
