import { createRenderer, defineComponent, h, ssrContextKey, type Component } from 'vue';
import { i18n } from '../../../src/service/locale-preference-service.js';

export class SessionGroupTestNode {
  readonly children: SessionGroupTestNode[] = [];
  readonly props = new Map<string, unknown>();
  parentNode: SessionGroupTestNode | null = null;
  text = '';
  focused = false;

  constructor(
    readonly type: string,
    text = ''
  ) {
    this.text = text;
  }

  get parentElement(): SessionGroupTestNode | null {
    return this.parentNode;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  findAll(predicate: (node: SessionGroupTestNode) => boolean): SessionGroupTestNode[] {
    return this.children.flatMap((child) => [
      ...(predicate(child) ? [child] : []),
      ...child.findAll(predicate)
    ]);
  }

  querySelector(selector: string): SessionGroupTestNode | null {
    const group = /^\[data-group="([^"]+)"\]$/u.exec(selector)?.[1];
    return group === undefined
      ? null
      : (this.findAll((node) => node.props.get('data-group') === group)[0] ?? null);
  }

  focus(): void {
    this.focused = true;
  }

  invoke(eventName: string, ...args: unknown[]): void {
    const handler = this.props.get(eventName);
    if (typeof handler === 'function') {
      (handler as (...values: unknown[]) => void)(...args);
    } else if (Array.isArray(handler)) {
      for (const callback of handler)
        if (typeof callback === 'function') (callback as (...values: unknown[]) => void)(...args);
    }
  }
}

const renderer = createRenderer<SessionGroupTestNode, SessionGroupTestNode>({
  patchProp(node, key, _previous, next) {
    node.props.set(key, next);
  },
  insert(node, parent, anchor) {
    if (node.parentNode !== null) {
      const previousIndex = node.parentNode.children.indexOf(node);
      if (previousIndex >= 0) node.parentNode.children.splice(previousIndex, 1);
    }
    node.parentNode = parent;
    const anchorIndex =
      anchor === null || anchor === undefined ? -1 : parent.children.indexOf(anchor);
    if (anchorIndex < 0) parent.children.push(node);
    else parent.children.splice(anchorIndex, 0, node);
  },
  remove(node) {
    if (node.parentNode === null) return;
    const index = node.parentNode.children.indexOf(node);
    if (index >= 0) node.parentNode.children.splice(index, 1);
    node.parentNode = null;
  },
  createElement: (type) => new SessionGroupTestNode(type),
  createText: (text) => new SessionGroupTestNode('#text', text),
  createComment: (text) => new SessionGroupTestNode('#comment', text),
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.children.length = 0;
    node.text = text;
  },
  parentNode: (node) => node.parentNode,
  nextSibling(node) {
    const siblings = node.parentNode?.children;
    if (siblings === undefined) return null;
    return siblings[siblings.indexOf(node) + 1] ?? null;
  }
});

export function mountSessionGroupTestComponent(
  component: Component,
  props: Record<string, unknown>
) {
  const container = new SessionGroupTestNode('root');
  const app = renderer.createApp({ render: () => h(component, props) });
  app.use(i18n);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.directive('tooltip', {});
  for (const name of ['el-badge', 'el-tag'])
    app.component(
      name,
      defineComponent({
        setup:
          (_, { attrs, slots }) =>
          () =>
            h('span', attrs, slots.default?.())
      })
    );
  app.mount(container);
  return { app, container };
}
