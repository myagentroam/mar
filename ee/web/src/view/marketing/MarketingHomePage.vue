<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import logoIcon from '@myagentroam/web-core/assets/logo-icon.png';
import heroZh from '../../../../../docs/assets/workbench-hero.zh-CN.png';
import heroEn from '../../../../../docs/assets/workbench-hero.en-US.png';
import networkZh from '../../../../../docs/assets/agent-network.zh-CN.png';
import networkEn from '../../../../../docs/assets/agent-network.en-US.png';
import mobileZh from '@/assets/marketing-mobile.zh-CN.png';
import mobileEn from '@/assets/marketing-mobile.en-US.png';
import {
  localizedDocsPath,
  localePreferenceService,
  SUPPORTED_LOCALES,
  type AppLocale
} from '@/service/LocalePreferenceService';

const { t } = useI18n();
const localeService = localePreferenceService();
const locale = localeService.locale;
const docsPath = (path: string) => localizedDocsPath(locale.value, path);
const selectLanguage = (value: string | number | boolean | undefined) =>
  localeService.setLocale(value as AppLocale);
const repository = 'https://github.com/myagentroam/mar';
const screenshots = {
  'zh-CN': { hero: heroZh, network: networkZh, mobile: mobileZh },
  'en-US': { hero: heroEn, network: networkEn, mobile: mobileEn }
} satisfies Record<AppLocale, { hero: string; network: string; mobile: string }>;
const images = computed(() => screenshots[locale.value]);
const runners = ['marAgent', 'codex', 'claudeCode', 'openCode'] as const;
const contextFeatures = [
  { title: 'gcTitle', body: 'gcBody' },
  { title: 'compactTitle', body: 'compactBody' },
  { title: 'controlTitle', body: 'controlBody' }
] as const;
const deviceFeatures = [
  { title: 'desktop', body: 'desktopBody' },
  { title: 'mobile', body: 'mobileBody' },
  { title: 'return', body: 'returnBody' }
] as const;
const capabilities = [
  'gc',
  'steer',
  'codeMode',
  'subagents',
  'network',
  'autoAccess',
  'computerUse'
] as const;
</script>

<template>
  <main class="marketing-home">
    <div class="page-width">
      <header class="marketing-nav">
        <a class="marketing-brand" href="/" :aria-label="t('marketing.home')">
          <img :src="logoIcon" alt="" width="36" height="36" />
          <span>{{ t('common.productName') }}</span>
        </a>
        <nav :aria-label="t('marketing.navigation')">
          <a href="#features">{{ t('marketing.features') }}</a>
          <a :href="docsPath('getting-started/overview')">{{ t('marketing.docs') }}</a>
          <el-select
            class="language-select"
            :model-value="locale"
            :aria-label="t('common.switchLanguage')"
            @change="selectLanguage"
          >
            <el-option
              v-for="option in SUPPORTED_LOCALES"
              :key="option.value"
              :label="option.nativeLabel"
              :value="option.value"
            />
          </el-select>
          <a class="console-link" href="/console"
            >{{ t('marketing.console') }} <span aria-hidden="true">→</span></a
          >
        </nav>
      </header>
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-copy">
          <h1 id="hero-title">
            {{ t('marketing.heroStart') }}<br /><em>{{ t('marketing.heroEmphasis') }}</em>
          </h1>
          <p class="hero-summary">
            {{ t('marketing.summary') }}<br />{{ t('marketing.summaryDetail') }}
          </p>
          <div class="actions">
            <a class="primary-action" :href="repository"
              >{{ t('marketing.github') }} <span aria-hidden="true">↗</span></a
            >
            <a class="secondary-action" :href="docsPath('getting-started/server-installation')"
              >{{ t('marketing.deploymentDocs') }} <span aria-hidden="true">→</span></a
            >
          </div>
          <div class="runner-line">
            <span>{{ t('marketing.runnersLabel') }}</span>
            <ul :aria-label="t('marketing.runnersLabel')">
              <li v-for="runner in runners" :key="runner">{{ t('marketing.' + runner) }}</li>
            </ul>
          </div>
        </div>
        <figure class="hero-visual">
          <img
            :src="images.hero"
            :alt="t('marketing.heroAlt')"
            width="3840"
            height="2400"
            fetchpriority="high"
          />
        </figure>
      </section>
      <section class="positioning" aria-labelledby="position-title">
        <div>
          <h2 id="position-title">{{ t('marketing.positionTitle') }}</h2>
          <p>{{ t('marketing.positionAgent') }}<br />{{ t('marketing.positionBrowser') }}</p>
        </div>
        <div class="topology" :aria-label="t('marketing.topologyLabel')">
          <span>{{ t('marketing.browser') }}</span
          ><b aria-hidden="true">→</b><span>{{ t('marketing.server') }}</span
          ><b aria-hidden="true">→</b
          ><span
            >{{ t('marketing.node') }}<small>{{ t('marketing.workspace') }}</small></span
          >
        </div>
      </section>
      <section id="features" class="feature-section" aria-labelledby="context-title">
        <div class="section-heading">
          <h2 id="context-title">
            {{ t('marketing.contextTitle') }}<br />{{ t('marketing.contextTitleEnd') }}
          </h2>
          <p>{{ t('marketing.contextIntro') }}</p>
        </div>
        <div class="context-grid">
          <dl class="context-features">
            <div v-for="feature in contextFeatures" :key="feature.title">
              <dt>{{ t('marketing.' + feature.title) }}</dt>
              <dd>{{ t('marketing.' + feature.body) }}</dd>
            </div>
          </dl>
          <aside class="context-evidence" :aria-label="t('marketing.caseLabel')">
            <div class="evidence-heading">
              <span>{{ t('marketing.gc') }}</span
              ><span>{{ t('marketing.caseDate') }}</span>
            </div>
            <div class="evidence-number">
              {{ t('marketing.reduction') }}<span>{{ t('marketing.percent') }}</span>
            </div>
            <p class="evidence-label">{{ t('marketing.reductionLabel') }}</p>
            <dl class="evidence-workload">
              <div>
                <dt>{{ t('marketing.realSession') }}</dt>
                <dd>
                  {{ t('marketing.duration') }}<span>{{ t('marketing.hours') }}</span>
                </dd>
              </div>
              <div>
                <dt>{{ t('marketing.requests') }}</dt>
                <dd>{{ t('marketing.requestCount') }}</dd>
              </div>
              <div>
                <dt>{{ t('marketing.compactions') }}</dt>
                <dd>
                  {{ t('marketing.compactCount') }}<span>{{ t('marketing.times') }}</span>
                </dd>
              </div>
            </dl>
            <p class="fineprint evidence-note">{{ t('marketing.caseNote') }}</p>
            <a class="text-link" :href="repository + '/blob/develop/CONTEXT_GC_CASE_STUDY.md'"
              >{{ t('marketing.caseSource') }} <span aria-hidden="true">↗</span></a
            >
          </aside>
        </div>
      </section>
      <section class="feature-section anywhere" aria-labelledby="anywhere-title">
        <div>
          <h2 id="anywhere-title">
            {{ t('marketing.anywhereTitle') }}<br />{{ t('marketing.anywhereTitleEnd') }}
          </h2>
          <p>{{ t('marketing.anywhereBody') }}</p>
          <ul class="device-features">
            <li v-for="feature in deviceFeatures" :key="feature.title">
              <span>{{ t('marketing.' + feature.title) }}</span
              >{{ t('marketing.' + feature.body) }}
            </li>
          </ul>
          <p class="computer-use">{{ t('marketing.computerUseBody') }}</p>
          <p class="fineprint">{{ t('marketing.anywhereNote') }}</p>
        </div>
        <figure class="mobile-scene">
          <div class="mobile-frame">
            <img
              :src="images.mobile"
              :alt="t('marketing.mobileAlt')"
              width="780"
              height="1688"
              loading="lazy"
            />
          </div>
          <figcaption>
            <strong
              >{{ t('marketing.sameWorkspace') }}<br />{{ t('marketing.anotherScreen') }}</strong
            >
          </figcaption>
        </figure>
      </section>
      <section class="network" aria-labelledby="network-title">
        <div>
          <h2 id="network-title">
            {{ t('marketing.network') }}<br /><span>{{ t('marketing.networkTitle') }}</span>
          </h2>
          <p>{{ t('marketing.networkBody') }}</p>
          <p class="fineprint">{{ t('marketing.networkNote') }}</p>
        </div>
        <figure>
          <img
            :src="images.network"
            :alt="t('marketing.networkAlt')"
            width="3840"
            height="2400"
            loading="lazy"
          />
        </figure>
      </section>
      <section class="capabilities" :aria-label="t('marketing.capabilitiesLabel')">
        <p>{{ t('marketing.capabilitiesLabel') }}</p>
        <ul>
          <li v-for="capability in capabilities" :key="capability">
            {{ t('marketing.' + capability) }}
          </li>
        </ul>
        <a class="text-link" :href="docsPath('runners/mar-agent')"
          >{{ t('marketing.capabilitiesDocs') }} <span aria-hidden="true">↗</span></a
        >
      </section>
      <footer>
        <section class="closing" aria-labelledby="closing-title">
          <div>
            <h2 id="closing-title">{{ t('marketing.closingTitle') }}</h2>
            <p class="fineprint">{{ t('marketing.audience') }}</p>
          </div>
          <div class="actions">
            <a class="primary-action" :href="repository"
              >{{ t('marketing.github') }} <span aria-hidden="true">↗</span></a
            ><a class="secondary-action" :href="docsPath('getting-started/server-installation')"
              >{{ t('marketing.deploymentDocs') }} <span aria-hidden="true">→</span></a
            >
          </div>
        </section>
        <p class="license">
          {{ t('marketing.license') }} ·
          <a :href="repository + '/blob/develop/LICENSING.md'"
            >{{ t('marketing.licenseLink') }} <span aria-hidden="true">↗</span></a
          >
        </p>
      </footer>
    </div>
  </main>
</template>

<style scoped>
.marketing-home {
  --ink: #192539;
  --muted: #505c6d;
  --subtle: #626c7c;
  --blue: #315de7;
  --line: #e4e8ef;
  background: #fff;
  color: var(--ink);
  min-height: 100vh;
  font-family: Arial, 'Noto Sans CJK SC', sans-serif;
  -webkit-font-smoothing: antialiased;
  color-scheme: light;
}
.marketing-home :deep(*) {
  box-sizing: border-box;
}
a {
  color: inherit;
  text-decoration: none;
}
a:hover {
  color: var(--blue);
}
a:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 5px;
}
img {
  display: block;
  max-width: 100%;
  height: auto;
}
h1,
h2,
p,
figure,
dl,
dd {
  margin: 0;
}
p {
  line-height: 1.85;
  color: var(--muted);
}
.page-width {
  max-width: 75rem;
  padding: 0 2.5rem;
  margin: auto;
}
.marketing-nav {
  min-height: 6.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}
.marketing-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 1.3125rem;
  font-weight: 750;
  letter-spacing: -0.04em;
}
.marketing-brand img {
  width: 2.25rem;
  height: 2.25rem;
  object-fit: contain;
}
.marketing-nav nav {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 1.5rem;
  font-size: 0.9375rem;
}
.console-link {
  border: 1px solid #d9dfe8;
  border-radius: 5px;
  padding: 0.6875rem 1rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.language-select {
  width: 7.5rem;
}
.language-select :deep(.el-select__wrapper) {
  background: #fff;
  box-shadow: none;
  font-size: 0.9375rem;
}
.language-select :deep(.el-select__selected-item) {
  color: var(--muted);
}
.language-select:focus-within {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
  border-radius: 5px;
}
.hero {
  padding-top: 2.625rem;
  text-align: center;
}
h1 {
  font-size: 6.5rem;
  line-height: 1.03;
  font-weight: 750;
  letter-spacing: -0.058em;
}
h1 em {
  font-style: normal;
  color: var(--blue);
}
.hero-summary {
  max-width: 42.5rem;
  text-wrap: balance;
  margin: 1.6875rem auto 1.5rem;
  font-size: 1rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 0.75rem;
}
.primary-action,
.secondary-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  min-height: 3rem;
  padding: 0.75rem 1.5rem;
  border: 1px solid var(--ink);
  border-radius: 5px;
  font-size: 1rem;
  font-weight: 650;
  line-height: 1.5;
}
.primary-action {
  background: var(--ink);
  color: #fff;
}
.primary-action:hover {
  background: #2c3e59;
  color: #fff;
}
.secondary-action {
  border-color: #d3dce8;
}
.secondary-action:hover,
.console-link:hover {
  background: #f4f6fa;
  color: var(--ink);
}
.runner-line,
.runner-line ul {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
}
.runner-line {
  margin: 1.8125rem 0 2.3125rem;
  color: var(--muted);
  font-size: 0.875rem;
}
.runner-line ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.runner-line li {
  color: #27354e;
  font-size: 0.9375rem;
  font-weight: 600;
}
.hero-visual img,
.network img {
  width: 100%;
  border: 1px solid #d8dfe9;
  border-radius: 7px;
}
.hero-visual img {
  box-shadow: 0 15px 45px -30px #253b6d66;
}
figcaption {
  font-size: 0.8125rem;
  color: var(--subtle);
  line-height: 1.8;
  margin-top: 0.75rem;
  text-align: left;
}
.positioning {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: 2.8125rem;
  align-items: center;
  padding: 3rem 0 2.375rem;
  border-bottom: 1px solid var(--line);
}
.positioning h2 {
  font-size: 1.5625rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.025em;
  margin-bottom: 0.6875rem;
}
.positioning p {
  font-size: 1rem;
}
.topology {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1.125rem;
  font-family: monospace;
  font-size: 0.9375rem;
  padding-bottom: 1.5625rem;
}
.topology > span {
  position: relative;
}
.topology b {
  font-weight: 400;
  color: #8190a4;
}
.topology small {
  position: absolute;
  top: 1.5625rem;
  right: 0;
  white-space: nowrap;
  font-size: 0.75rem;
  color: var(--subtle);
}
.feature-section {
  padding: 5.125rem 0;
  border-bottom: 1px solid var(--line);
}
.feature-section h2 {
  font-size: 2.375rem;
  line-height: 1.35;
  letter-spacing: -0.04em;
  font-weight: 650;
}
.section-heading {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5rem;
  margin-bottom: 2.6875rem;
}
.section-heading > p {
  font-size: 1rem;
  margin-top: 0.1875rem;
}
.context-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4.75rem;
  align-items: start;
}
.context-features > div {
  padding: 1.1875rem 0;
  border-top: 1px solid var(--line);
}
.context-features > div:first-child {
  padding-top: 0;
  border: 0;
}
.context-features dt {
  font-size: 1rem;
  font-weight: 650;
  margin-bottom: 0.5rem;
}
.context-features dd {
  font-size: 0.9375rem;
  color: var(--muted);
  line-height: 1.85;
}
.context-evidence {
  padding-left: 2.125rem;
  border-left: 1px solid var(--line);
  min-width: 0;
}
.evidence-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.9375rem;
  color: var(--subtle);
  font-size: 0.8125rem;
  line-height: 1.5;
}
.evidence-heading > span:first-child {
  font-weight: 600;
  color: #344257;
  font-size: 0.875rem;
}
.evidence-number {
  font-size: 5rem;
  font-weight: 400;
  line-height: 1.05;
  letter-spacing: -0.05em;
  margin: 1.625rem 0 0.75rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.evidence-number > span {
  font-size: 2.6875rem;
  margin-left: 0.1875rem;
}
.evidence-label {
  font-size: 0.9375rem;
  margin-bottom: 1.8125rem;
}
.evidence-workload {
  display: grid;
  grid-template-columns: 1.1fr 1fr 0.8fr;
  gap: 1rem;
  padding: 1.1875rem 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.evidence-workload > div {
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 0.5rem;
}
.evidence-workload dt {
  font-size: 0.8125rem;
  font-weight: 400;
  color: var(--subtle);
}
.evidence-workload dd {
  font-size: 1.5rem;
  line-height: 1.2;
  color: #344257;
  letter-spacing: -0.03em;
  white-space: nowrap;
}
.evidence-workload dd > span {
  font-size: 0.8125rem;
  letter-spacing: 0;
  margin-left: 0.3125rem;
}
.fineprint {
  font-size: 0.8125rem;
  line-height: 1.85;
  color: var(--subtle);
}
.evidence-note {
  margin: 1.125rem 0 0.75rem;
}
.text-link {
  display: inline-flex;
  align-items: center;
  gap: 1.5625rem;
  font-size: 0.875rem;
  line-height: 1.8;
  color: #344257;
}
.text-link span {
  color: var(--blue);
}
.anywhere {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5.625rem;
  align-items: center;
}
.anywhere h2 {
  margin-bottom: 1.5rem;
}
.anywhere p {
  font-size: 1rem;
}
.anywhere .fineprint {
  font-size: 0.8125rem;
}
.device-features {
  list-style: none;
  padding: 0;
  margin: 1.625rem 0;
}
.device-features li {
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--line);
  font-size: 1rem;
  line-height: 1.7;
}
.device-features li span {
  display: inline-block;
  margin-right: 1.25rem;
  font-size: 0.875rem;
  color: var(--subtle);
}
.computer-use {
  padding-left: 0.9375rem;
  border-left: 2px solid #c6d3ec;
  margin-bottom: 0.875rem;
}
.mobile-scene {
  background: #f5f7fb;
  border-radius: 7px;
  padding: 1.875rem;
  display: flex;
  gap: 1.625rem;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.mobile-frame {
  width: 13.1875rem;
  flex-shrink: 1;
  border: 5px solid #202833;
  border-radius: 23px;
  overflow: hidden;
  box-shadow: 0 12px 25px #24324b20;
}
.mobile-frame img {
  width: 100%;
}
.mobile-scene figcaption {
  max-width: 7.5rem;
  font-size: 0.875rem;
  line-height: 1.9;
  margin: 0;
}
.mobile-scene strong {
  display: block;
  color: var(--ink);
  font-size: 1rem;
  font-weight: 500;
  margin-bottom: 0.625rem;
}
.network {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4.0625rem;
  align-items: center;
  padding: 3.5625rem 0 2.1875rem;
}
.network h2 {
  font-size: 1.5625rem;
  line-height: 1.5;
  margin-bottom: 0.9375rem;
  letter-spacing: -0.02em;
}
.network h2 span {
  font-size: 1.3125rem;
  font-weight: 500;
}
.network p {
  font-size: 1rem;
}
.network .fineprint {
  font-size: 0.8125rem;
  margin-top: 0.875rem;
}
.capabilities {
  padding: 1.25rem 0 2.8125rem;
  font-size: 0.9375rem;
  line-height: 2;
  color: #344257;
}
.capabilities p {
  font-size: 0.875rem;
  color: var(--subtle);
  margin-bottom: 0.5rem;
}
.capabilities ul {
  display: flex;
  flex-wrap: wrap;
  list-style: none;
  margin: 0;
  padding: 0;
  gap: 0 1.125rem;
}
.capabilities li:not(:last-child)::after {
  content: '·';
  margin-left: 1.125rem;
  color: #7a8699;
}
.capabilities .text-link {
  margin-top: 0.625rem;
}
.closing {
  border-top: 1px solid var(--line);
  padding: 2.875rem 0 3.375rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1.875rem;
}
.closing h2 {
  font-size: 1.6875rem;
  letter-spacing: -0.025em;
  margin-bottom: 0.625rem;
}
.closing > div {
  min-width: 0;
}
.closing .actions {
  flex-shrink: 0;
}
.license {
  padding-bottom: 1.5rem;
  font-size: 0.8125rem;
  color: var(--subtle);
}
@media (max-width: 960px) {
  .marketing-nav {
    flex-wrap: wrap;
    padding: 1.25rem 0;
    gap: 1rem;
  }
  .marketing-nav nav {
    gap: 1rem;
  }
  .anywhere {
    gap: 2rem;
  }
  .mobile-scene {
    padding: 1.25rem;
    gap: 1rem;
  }
  .mobile-frame {
    width: 11rem;
  }
  .context-grid {
    gap: 2rem;
  }
  .closing {
    align-items: flex-start;
    flex-direction: column;
  }
}
@media (max-width: 760px) {
  .page-width {
    padding: 0 1.375rem;
  }
  .marketing-nav {
    min-height: 4.875rem;
  }
  .marketing-brand {
    font-size: 1.0625rem;
    gap: 0.5rem;
  }
  .marketing-brand img {
    width: 1.8125rem;
    height: 1.8125rem;
  }
  .marketing-nav nav {
    width: 100%;
    justify-content: flex-start;
    gap: 0.75rem 1rem;
    font-size: 0.875rem;
  }
  .language-select {
    width: 6.75rem;
  }
  .console-link {
    padding: 0.5rem 0.75rem;
  }
  .hero {
    padding-top: 2.125rem;
  }
  h1 {
    font-size: clamp(2.5rem, 11.7vw, 4.9375rem);
    letter-spacing: -0.048em;
    line-height: 1.12;
  }
  .hero-summary {
    font-size: 0.9375rem;
    margin: 1.5rem auto;
  }
  .primary-action,
  .secondary-action {
    padding: 0.75rem 1.125rem;
    font-size: 0.9375rem;
    gap: 1rem;
  }
  .runner-line,
  .runner-line ul {
    gap: 0.8125rem;
  }
  .runner-line {
    margin: 1.5625rem 0 1.75rem;
  }
  .runner-line > span {
    width: 100%;
  }
  .runner-line li {
    font-size: 0.875rem;
  }
  .positioning {
    grid-template-columns: 1fr;
    gap: 1.5rem;
    padding: 2.1875rem 0 2.6875rem;
  }
  .positioning h2 {
    font-size: 1.4375rem;
    line-height: 1.26;
    margin-bottom: 0.75rem;
  }
  .positioning p {
    font-size: 0.9375rem;
  }
  .topology {
    justify-content: flex-start;
    gap: 1.375rem;
  }
  .topology small {
    right: 0;
  }
  .feature-section {
    padding: 3.125rem 0;
  }
  .feature-section h2 {
    font-size: 1.8125rem;
  }
  .section-heading,
  .context-grid,
  .anywhere,
  .network {
    grid-template-columns: 1fr;
    gap: 1.75rem;
  }
  .section-heading {
    margin-bottom: 1.875rem;
  }
  .section-heading > p {
    font-size: 1rem;
  }
  .context-grid {
    gap: 1.875rem;
  }
  .context-features > div {
    padding: 1rem 0;
  }
  .context-evidence {
    padding: 1.5rem 0 0;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
  .evidence-number {
    font-size: 4.5rem;
    margin-top: 1.5rem;
  }
  .evidence-number > span {
    font-size: 2.375rem;
  }
  .evidence-workload {
    gap: 0.75rem;
  }
  .evidence-workload dd {
    font-size: 1.4375rem;
  }
  .evidence-label {
    margin-bottom: 1.5rem;
  }
  .anywhere h2 {
    margin-bottom: 1.125rem;
  }
  .mobile-scene {
    padding: 1.5625rem 1.125rem;
    gap: 1.375rem;
  }
  .mobile-frame {
    width: 11.5625rem;
  }
  .mobile-scene figcaption {
    font-size: 0.8125rem;
  }
  .network {
    padding: 2.625rem 0 1.3125rem;
    gap: 1.5625rem;
  }
  .network h2 {
    font-size: 1.4375rem;
  }
  .network h2 span {
    font-size: 1.25rem;
  }
  .capabilities {
    padding-bottom: 2rem;
  }
  .closing h2 {
    font-size: 1.5rem;
  }
}
@media (max-width: 360px) {
  .mobile-frame {
    width: 10rem;
  }
  .mobile-scene {
    padding: 1.25rem 0.75rem;
    gap: 0.9375rem;
  }
  .mobile-scene strong {
    font-size: 0.9375rem;
  }
  .closing .actions {
    flex-shrink: 1;
  }
}
</style>
