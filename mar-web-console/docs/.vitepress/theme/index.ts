import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import ServerVersionCommand from './components/ServerVersionCommand.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }: { app: { component: (name: string, component: unknown) => void } }) {
    app.component('ServerVersionCommand', ServerVersionCommand);
  }
};
