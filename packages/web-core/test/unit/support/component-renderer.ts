import {
  createRenderer,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  ssrContextKey,
  type Component,
  type ComponentInternalInstance,
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
  clientWidth: number;
  querySelector(): null;
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
    clientWidth: 1280,
    querySelector: () => null,
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
  const teleportRoot = element('teleport-root');
  const renderer = createRenderer<TestElement, TestElement>({
    querySelector: () => teleportRoot,
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
  // Button business tests read live caller props and invoke the caller's handler, as with an EL
  // dependency stub. The rendered button remains real; native activation is tested in Chromium.
  const boundaries = new WeakMap<TestElement, TestElement>();
  function boundaryView(instance: ComponentInternalInstance, name: string): void {
    const host = instance.subTree.el as TestElement;
    const view: TestElement = {
      ...host,
      type: name,
      get parent() {
        return host.parent;
      },
      get children() {
        return name === 'MarButton'
          ? (host.children.find((node) => node.props.class === 'mar-ui-button__label')?.children ??
              [])
          : host.children;
      },
      get props() {
        return { ...instance.props, ...instance.vnode.props };
      }
    };
    boundaries.set(host, view);
  }
  app.mixin({
    mounted() {
      const type = this.$.type;
      if (typeof type === 'function') return;
      const name = type.name ?? type.__name;
      if (name === 'MarButton' || name === 'MarForm') boundaryView(this.$, name);
      if (name === 'MarForm' && this.$.exposed && options.validate)
        this.$.exposed.validate = options.validate;
    }
  });
  const rowsKey: InjectionKey<() => Record<string, unknown>[]> = Symbol('table rows');
  for (const name of [
    'ElIcon',
    'ElInput',
    'ElInputNumber',
    'ElSelect',
    'ElSegmented',
    'ElOption',
    'ElOptionGroup',
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
    const visit = (node: TestElement): TestElement[] => {
      const boundary = boundaries.get(node);
      const match = boundary?.type === type ? boundary : node.type === type ? node : undefined;
      return [...(match ? [match] : []), ...node.children.flatMap(visit)];
    };
    return [...visit(root), ...visit(teleportRoot)];
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
