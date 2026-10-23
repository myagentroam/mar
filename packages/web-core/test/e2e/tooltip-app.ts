import { createApp, h, type Component } from 'vue';
import { tooltipPlugin } from '../../src/directive/tooltip.js';
import SharedTooltipHost from '../../src/view/common/SharedTooltipHost.vue';

// Browser fixtures use the same app-scoped directive and Host as the console shell.
export function createTooltipApp(component: Component) {
  return createApp({
    render: () => [h(SharedTooltipHost), h(component)]
  }).use(tooltipPlugin);
}
