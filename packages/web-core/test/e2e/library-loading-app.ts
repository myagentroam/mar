import { createApp, h, withDirectives } from 'vue';
import { vMarLoading } from '@myagentroam/mar-ui/loading';
import '../../src/styles.css';

// Mount both loading variants without importing or mounting MarBusyIndicator.
createApp({
  render: () => [
    withDirectives(
      h('div', { id: 'library-loading', class: 'mar-page-loading', style: 'height: 80px' }),
      [[vMarLoading, true, 'page']]
    ),
    withDirectives(h('div', { id: 'library-region', style: 'height: 80px' }), [
      [vMarLoading, true, 'region']
    ])
  ]
}).mount('#app');
