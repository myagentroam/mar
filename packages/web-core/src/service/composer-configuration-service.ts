import { computed, ref, type Ref } from 'vue';
import type { RunnerDefaultConfiguration, RunnerProfile, Session } from '../model/workbench.js';
import { runnerLabel as presentRunnerLabel } from '../util/runner-presentation.js';
import { defaultEffortForModel } from './runner-profile-service.js';

export function createComposerConfigurationService(options: {
  readonly selectedSession: Ref<Session | undefined>;
  readonly profiles: Ref<readonly RunnerProfile[]>;
  readonly effortLabel: (effort: string) => string;
}) {
  const runner = ref<Session['runner']>('mar-agent');
  const model = ref('');
  const effort = ref('medium');
  const access = ref('on-request');
  const modelEffortSelection = ref<string>();
  const activeRunner = computed(() => options.selectedSession.value?.runner ?? runner.value);
  const profile = computed(() =>
    options.profiles.value.find((candidate) => candidate.runner === activeRunner.value)
  );
  const models = computed(() => profile.value?.models ?? []);
  const selectedModel = computed(() =>
    models.value.find((candidate) => candidate.id === model.value)
  );
  const efforts = computed(() => selectedModel.value?.supportedEfforts ?? []);
  const accessOptions = computed(() => profile.value?.accessOptions ?? []);
  const modelEffortLabel = computed(() => {
    const label = selectedModel.value?.label ?? presentRunnerLabel(activeRunner.value);
    const effortLabel = options.effortLabel(effort.value);
    return effortLabel.length === 0 ? label : `${label} ${effortLabel}`;
  });
  const runnerLabel = computed(() => presentRunnerLabel(activeRunner.value));
  const accessLabel = computed(
    () => accessOptions.value.find((option) => option.id === access.value)?.label ?? access.value
  );

  function normalize(): void {
    const current = options.profiles.value.find((candidate) => candidate.runner === runner.value);
    if (current === undefined) return;
    if (!current.models.some((candidate) => candidate.id === model.value))
      model.value = current.models[0]?.id ?? '';
    const selected = current.models.find((candidate) => candidate.id === model.value);
    if (selected !== undefined) {
      const defaultEffort = defaultEffortForModel(selected);
      const supported =
        selected.supportedEfforts.length === 0
          ? effort.value === defaultEffort
          : selected.supportedEfforts.includes(effort.value);
      if (!supported) effort.value = defaultEffort;
    }
    if (!current.accessOptions.some((candidate) => candidate.id === access.value))
      access.value = current.accessOptions[0]?.id ?? 'on-request';
  }

  function apply(configuration: RunnerDefaultConfiguration): void {
    runner.value = configuration.runner;
    model.value = configuration.model;
    effort.value = configuration.effort;
    access.value = configuration.access;
    normalize();
  }

  return {
    runner,
    model,
    effort,
    access,
    modelEffortSelection,
    activeRunner,
    profile,
    models,
    selectedModel,
    efforts,
    accessOptions,
    modelEffortLabel,
    runnerLabel,
    accessLabel,
    normalize,
    apply
  };
}
