import { createApp, h, ref } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import ConversationImageThumbnail from '../../src/view/conversation/ConversationImageThumbnail.vue';
import ImagePreviewDialogs from '../../src/view/conversation/ImagePreviewDialogs.vue';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import { createConversationImageService } from '../../src/service/conversation-image-service.js';

const query = new URLSearchParams(location.search);
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(
  query.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
const source = (name: string) => `/api/agent-runs/fixture/images/${name}?nodeId=node`;
const first = source(query.get('first') ?? 'slow');
const second = source('fast');
const name = query.get('name') ?? 'Image preview';
const images = createConversationImageService(ref('node'), {
  fileAttachments: {
    target: ref('fixture'),
    revalidate: async () => undefined,
    sourceUrl: () => first,
    onError: () => undefined
  }
});
const { previewOpen: open, preview } = images;
function show(url: string): void {
  if (query.get('attachment') === '1' && url === first) {
    void images.openFileAttachment({ name, mime: 'image/png', path: 'image.png' });
  } else images.open({ name, previewUrl: url });
}

createApp({
  render: () =>
    h('main', { style: 'padding: 16px' }, [
      h(ConversationImageThumbnail, {
        source: first,
        name: 'First image',
        onClick: () => show(first)
      }),
      h('button', { onClick: () => show(second) }, 'Second image'),
      h(AgentMarkdown, {
        content: '![Markdown picture](picture.png)',
        imageResourceUrl: () => second,
        'onOpen-image': (url: string) => show(url)
      }),
      h(ImagePreviewDialogs, {
        attachmentOpen: false,
        attachment: undefined,
        conversationOpen: open.value,
        conversation: preview.value,
        onConversationError: (url: string) => void images.previewFailed(url),
        'onUpdate:conversationOpen': (value: boolean) => {
          open.value = value;
        }
      })
    ])
})
  .use(i18n)
  .use(ElementPlus)
  .directive('tooltip', {})
  .mount('#app');
