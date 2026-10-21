import { zhSidebar, zhDocumentationMessages as zh } from './navigation.zh-CN';
import { enSidebar } from './navigation.en-US';
import { resolve } from 'node:path';
import { defineConfig } from 'vitepress';
import { SUPPORTED_LOCALES } from '@myagentroam-enterprise/web-implementation/locale-config';

const localeLabel = (value: 'zh-CN' | 'en-US') =>
  SUPPORTED_LOCALES.find((locale) => locale.value === value)!.nativeLabel;

export default defineConfig({
  lang: 'zh-CN',
  title: 'MyAgentRoam Documentation',
  description: zh.description,
  base: '/docs/',
  locales: {
    root: { label: localeLabel('zh-CN'), lang: 'zh-CN' },
    'en-US': {
      label: localeLabel('en-US'),
      lang: 'en-US',
      title: 'MyAgentRoam Documentation',
      description: 'Deployment, configuration, and usage documentation for MyAgentRoam',
      themeConfig: {
        siteTitle: 'Documentation',
        langMenuLabel: 'Switch language',
        outline: { label: 'On This Page', level: [2, 3] },
        returnToTopLabel: 'Return to Top',
        sidebarMenuLabel: 'Menu',
        darkModeSwitchLabel: 'Appearance',
        lightModeSwitchTitle: 'Switch to Light Theme',
        darkModeSwitchTitle: 'Switch to Dark Theme',
        docFooter: { prev: 'Previous', next: 'Next' },
        search: {
          provider: 'local',
          options: {
            translations: {
              button: {
                buttonText: 'Search Documentation',
                buttonAriaLabel: 'Search Documentation'
              }
            }
          }
        }
      }
    }
  },
  srcDir: '../../docs/help',
  outDir: '../dist/docs',
  cleanUrls: true,
  ignoreDeadLinks: false,
  vite: {
    publicDir: resolve(import.meta.dirname, '../public'),
    build: { target: 'esnext' },
    esbuild: { target: 'esnext', tsconfigRaw: { compilerOptions: { target: 'ESNext' } } }
  },
  themeConfig: {
    logo: '/logo.png?v=logo-20261011',
    logoLink: '/',
    siteTitle: 'Documentation',
    langMenuLabel: zh.langMenuLabel,
    outline: { label: zh.outline, level: [2, 3] },
    returnToTopLabel: zh.returnToTopLabel,
    sidebarMenuLabel: zh.sidebarMenuLabel,
    darkModeSwitchLabel: zh.darkModeSwitchLabel,
    lightModeSwitchTitle: zh.lightModeSwitchTitle,
    darkModeSwitchTitle: zh.darkModeSwitchTitle,
    docFooter: { prev: zh.prev, next: zh.next },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: zh.search, buttonAriaLabel: zh.search }
        }
      }
    },
    sidebar: { '/en-US/': enSidebar, '/': zhSidebar }
  }
});
