import { h } from 'vue';
import { createTooltipApp } from './tooltip-app.js';
import ConversationToolDetail from '../../src/view/conversation/tool-detail/ConversationToolDetail.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

createTooltipApp({
  render: () =>
    h(ConversationToolDetail, {
      item: {
        id: 'isolated-detail',
        kind: 'tool_call',
        status: 'FAILED',
        payload: {
          toolName: 'inspect',
          title: 'Inspect fixture',
          inputSummary: 'Preserved input',
          output: { blocks: [{ channel: 'TEXT', text: 'Inspection output' }], truncation: 'SOURCE' }
        }
      }
    })
})
  .use(i18n)
  .mount('#app');
