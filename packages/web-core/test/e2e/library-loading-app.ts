import { createApp, h, withDirectives } from 'vue';
import { vMarLoading } from '@myagentroam/mar-ui/loading';
import '../../src/styles.css';

// Mount the loading directive without importing or mounting BusyIndicator.
createApp({
  render: () =>
    withDirectives(
      h('div', { id: 'library-loading', class: 'mar-page-loading', style: 'height: 80px' }),
      [[vMarLoading, true, 'page']]
    )
}).mount('#app');
