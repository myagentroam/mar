import { createApp, h, withDirectives } from 'vue';
import { ElLoading } from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';

// Mount the library directive without importing or mounting BusyIndicator.
createApp({
  render: () =>
    withDirectives(
      h('div', { id: 'library-loading', class: 'mar-page-loading', style: 'height: 80px' }),
      [[ElLoading.directive, true]]
    )
}).mount('#app');
