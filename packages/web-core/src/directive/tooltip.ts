import type { ObjectDirective, Plugin } from 'vue';
import {
  TOOLTIP_SERVICE_KEY,
  TooltipService,
  type TooltipValue
} from '../service/tooltip-service.js';

export const tooltipPlugin: Plugin = {
  install(app) {
    const service = new TooltipService(document);
    const directive: ObjectDirective<Element, TooltipValue> = {
      mounted: (element, binding) => service.update(element, binding.value),
      updated: (element, binding) => service.update(element, binding.value),
      beforeUnmount: (element) => service.remove(element)
    };
    app.provide(TOOLTIP_SERVICE_KEY, service);
    app.directive('tooltip', directive);
    app.onUnmount(service.close);
  }
};
