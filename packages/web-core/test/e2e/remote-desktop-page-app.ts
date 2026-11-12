import { createApp, defineComponent, h } from 'vue';
import App from '../../src/App.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { tooltipPlugin } from '../../src/directive/tooltip.js';
import RFB from '@novnc/novnc';
import '../../src/styles.css';

// Hold a real noVNC firstframe callback to exercise page replacement races.
if (new URLSearchParams(window.location.search).has('holdFrame')) {
  const add = RFB.prototype.addEventListener;
  RFB.prototype.addEventListener = function (type, callback, options) {
    if (type === 'firstframe')
      return add.call(
        this,
        type,
        (event) => {
          (window as unknown as { releaseLateFrame: () => void }).releaseLateFrame = () => {
            if (typeof callback === 'function') callback.call(this, event);
            else callback?.handleEvent(event);
          };
        },
        options
      );
    return add.call(this, type, callback, options);
  };
}

const unused = defineComponent({ render: () => h('p', 'Unexpected workbench page') });
createApp(App, { workbench: unused, filePreview: unused })
  .use(i18n)
  .use(tooltipPlugin)
  .mount('#app');
