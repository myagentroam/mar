import { createApp, defineAsyncComponent, defineComponent, h, type Component } from 'vue';
import App from '../../src/App.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { tooltipPlugin } from '../../src/directive/tooltip.js';

const content = defineComponent({
  render: () =>
    h('main', { 'data-testid': 'workbench' }, [
      h('p', { id: 'ordinary' }, 'Workspace text'),
      h('input', { id: 'input' }),
      h('textarea', { id: 'textarea' }),
      h('select', { id: 'select' }, [h('option', 'Option')]),
      h('div', { contenteditable: 'true' }, [h('span', { id: 'editable' }, 'Editable text')]),
      h('div', { contenteditable: 'false' }, [h('span', { id: 'noneditable' }, 'Read only')]),
      h('img', { id: 'image', alt: 'Fixture image' }),
      h('video', { id: 'video' }),
      h('audio', { id: 'audio' })
    ])
});
let resolvePage: (component: Component) => void;
const resolveButton = document.getElementById('resolve-page') as HTMLButtonElement;
const workbench = defineAsyncComponent(
  () =>
    new Promise<Component>((resolve) => {
      resolvePage = resolve;
      resolveButton.disabled = false;
    })
);
resolveButton.addEventListener('click', () => resolvePage(content));
createApp(App, {
  workbench,
  filePreview: defineComponent({
    render: () => h('p', { 'data-testid': 'preview' }, 'Rendered preview')
  })
})
  .use(i18n)
  .use(tooltipPlugin)
  .mount('#app');
