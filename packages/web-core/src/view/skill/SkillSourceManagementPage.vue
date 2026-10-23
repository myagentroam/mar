<script setup lang="ts">
import { showMessage } from '../../service/MessageFeedbackService.js';

import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  createSkillCenterService,
  type SkillCandidateCard,
  type SkillSourceCard,
  type SkillSourceInput,
  type SkillFavoriteInput
} from '../../service/SkillCenterService';
import { skillErrorMessage } from '../../util/skill-errors';
import SkillDetailsDialog, { type SkillDetails } from './SkillDetailsDialog.vue';
import { translate } from '../../service/LocalePreferenceService';

import ManagementPagination from '../settings/ManagementPagination.vue';

const props = defineProps<{
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  writable: boolean;
  scopeLabel?: (scope: string) => string;
  loadExtension?: () => Promise<void>;
  sourceContext?: Readonly<Record<string, unknown>>;
  catalogContext?: Readonly<Record<string, unknown>>;
  ownershipRules?: FormRules;
  submitSource?: (input: SkillSourceInput) => Promise<unknown>;
  submitFavorite?: (input: SkillFavoriteInput) => Promise<unknown>;
}>();
const emit = defineEmits<{ openSource: []; openCatalog: [] }>();
const service = createSkillCenterService(props.request, {
  ...(props.submitSource === undefined ? {} : { submitSource: props.submitSource }),
  ...(props.submitFavorite === undefined ? {} : { submitFavorite: props.submitFavorite })
});
// Source definitions are a complete configuration snapshot, unlike directory entries.
const displayedSources = service.sources;
const pagination = service.catalogPage;
const sourceDialog = ref(false);
const catalogDialog = ref(false);
const editDialog = ref(false);
const detailsOpen = ref(false);
const initialLoading = ref(true);
const sourceSkillsLoading = ref(false);
const checkingSkillIds = ref<ReadonlySet<string>>(new Set());
const upgradingSkillId = ref<string>();
const sourceForm = ref<FormInstance>();
const catalogForm = ref<FormInstance>();
const editForm = ref<FormInstance>();
const pendingCandidate = ref<SkillCandidateCard>();
const pendingFavorite = ref<(typeof service.favorites.value)[number]>();
const skillDetails = ref<SkillDetails>();
const updateChecks = ref<
  Record<string, { readonly updateAvailable: boolean; readonly latestCommitSha: string }>
>({});
const catalogQuery = pagination.keyword;
const selectedCatalogCategory = pagination.category;
const activeSkillTab = ref<'source' | 'catalog'>('source');
const sourceDraft = reactive({
  name: '',
  locator: ''
});
const catalogDraft = reactive({
  featured: false,
  tags: [] as string[]
});
const editDraft = reactive({ featured: false, tags: [] as string[] });
const rules = computed<FormRules>(() => ({
  name: [
    {
      required: true,
      message: translate('generated.skillSourceManagementPage.enterASourceName'),
      trigger: 'blur'
    }
  ],
  locator: [
    {
      required: true,
      message: translate('generated.skillSourceManagementPage.enterARepositoryURL'),
      trigger: 'blur'
    },
    {
      validator: (_rule, value: unknown, callback) => {
        const locator = typeof value === 'string' ? value.trim() : '';
        if (
          /^https:\/\//u.test(locator) ||
          /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.git)?$/u.test(locator)
        )
          callback();
        else
          callback(
            new Error(
              translate('generated.skillSourceManagementPage.enterAnHTTPSOrGitSSHRepository')
            )
          );
      },
      trigger: 'blur'
    }
  ],

  tags: [
    {
      validator: (_rule, value: unknown, callback) => {
        const tags = Array.isArray(value) ? value.map((tag) => String(tag).trim()) : [];
        if (tags.some((tag) => tag.length === 0 || tag.length > 32))
          callback(
            new Error(
              translate('generated.skillSourceManagementPage.eachTagMustContain132Characters')
            )
          );
        else if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length)
          callback(
            new Error(translate('generated.skillSourceManagementPage.duplicateTagsAreNotAllowed'))
          );
        else callback();
      },
      trigger: 'change'
    }
  ]
}));
const selectedSource = computed(() =>
  service.sources.value.find((source) => source.id === service.selectedSourceId.value)
);
const catalogTags = pagination.tags;
const filteredFavorites = service.favorites;
watch(pagination.error, (error) => {
  if (error !== undefined)
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillSourceManagementPage.theSkillSourceOperationDidNotComplete')
      ),
      'error',
      error
    );
});

onMounted(() => {
  pagination.start();
  void loadPage();
});
onUnmounted(() => pagination.dispose());

async function loadPage(): Promise<void> {
  initialLoading.value = true;
  try {
    await run(async () => {
      await Promise.all([service.loadSources(), service.loadCatalog()]);
      if (service.selectedSourceId.value !== '') await loadSourceSkills();
      await props.loadExtension?.();
    });
  } finally {
    initialLoading.value = false;
  }
}

async function run(operation: () => Promise<void>, success?: string): Promise<void> {
  try {
    await operation();
    if (success !== undefined) showMessage(success, 'success');
  } catch (error) {
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillSourceManagementPage.theSkillSourceOperationDidNotComplete')
      ),
      'error',
      error
    );
  }
}

function openSourceDialog(): void {
  Object.assign(sourceDraft, {
    name: '',
    locator: ''
  });
  emit('openSource');
  sourceDialog.value = true;
}

async function addSource(): Promise<void> {
  if (!(await sourceForm.value?.validate().catch(() => false))) return;
  await run(async () => {
    await service.addSource({ name: sourceDraft.name.trim(), locator: sourceDraft.locator.trim() });
    sourceDialog.value = false;
  }, translate('generated.skillSourceManagementPage.skillSourceAdded'));
}

function openCatalogDialog(candidate: SkillCandidateCard): void {
  pendingCandidate.value = candidate;
  Object.assign(catalogDraft, {
    featured: false,
    tags: []
  });
  emit('openCatalog');
  catalogDialog.value = true;
}

function showCandidateDetails(candidate: SkillCandidateCard): void {
  skillDetails.value = {
    name: candidate.name,
    description: candidate.description,
    source: candidate.source,
    ...(candidate.skillPath === null ? {} : { path: candidate.skillPath }),
    ...(candidate.installs === null ? {} : { installs: candidate.installs })
  };
  detailsOpen.value = true;
}

function showSourceDetails(source: SkillSourceCard): void {
  skillDetails.value = {
    name: source.name,
    description: '',
    source: source.locator,
    scope: scopeLabel(source.scope),
    status: source.enabled
      ? translate('generated.skillSourceManagementPage.enabled')
      : translate('generated.skillSourceManagementPage.disabled')
  };
  detailsOpen.value = true;
}

function showFavoriteDetails(skill: (typeof service.favorites.value)[number]): void {
  skillDetails.value = {
    name: skill.normalizedName,
    description: skill.description,
    source: skill.repositoryIdentity,
    scope: scopeLabel(skill.scope),
    path: skill.skillPath,
    version: skill.commitSha.slice(0, 8),
    updatedAt: formatUpdatedAt(skill.updatedAt),
    featured: skill.featured,
    tags: skill.tags
  };
  detailsOpen.value = true;
}

function openEditDialog(skill: (typeof service.favorites.value)[number]): void {
  pendingFavorite.value = skill;
  editDraft.featured = skill.featured;
  editDraft.tags = [...skill.tags];
  editDialog.value = true;
}

async function savePresentation(): Promise<void> {
  if (!(await editForm.value?.validate().catch(() => false)) || pendingFavorite.value === undefined)
    return;
  const tags = editDraft.tags.map((tag) => tag.trim());
  await run(async () => {
    await service.updatePresentation(pendingFavorite.value!.id, {
      featured: editDraft.featured,
      tags
    });
    editDialog.value = false;
  }, translate('generated.skillSourceManagementPage.skillInformationUpdated'));
}

async function selectSource(sourceId: string): Promise<void> {
  service.selectedSourceId.value = sourceId;
  service.candidates.value = [];
  service.query.value = '';
  await run(loadSourceSkills);
}

async function loadSourceSkills(): Promise<void> {
  sourceSkillsLoading.value = true;
  try {
    await service.loadCandidates();
  } finally {
    sourceSkillsLoading.value = false;
  }
}

async function searchSourceSkills(): Promise<void> {
  sourceSkillsLoading.value = true;
  try {
    await service.search();
  } finally {
    sourceSkillsLoading.value = false;
  }
}

async function mutateSource(operation: () => Promise<void>): Promise<void> {
  const previousSourceId = service.selectedSourceId.value;
  await operation();
  if (service.selectedSourceId.value !== '' && service.selectedSourceId.value !== previousSourceId)
    await loadSourceSkills();
}

async function confirmSourceStatusChange(source: SkillSourceCard): Promise<void> {
  try {
    await ElMessageBox.confirm(
      source.enabled
        ? translate('generated.skillSourceManagementPage.confirmDisableSkillSource', {
            value0: source.name
          })
        : translate('generated.skillSourceManagementPage.confirmEnableSkillSource', {
            value0: source.name
          }),
      translate('generated.skillSourceManagementPage.updateSkillSourceStatus'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: source.enabled
          ? translate('generated.skillSourceManagementPage.disable')
          : translate('generated.skillSourceManagementPage.enable'),
        cancelButtonText: translate('generated.skillSourceManagementPage.cancel2')
      }
    );
  } catch (error) {
    if (isDialogCancellation(error)) return;
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillSourceManagementPage.unableToConfirmSourceStatusChange')
      ),
      'error',
      error
    );
    return;
  }
  await run(
    () => mutateSource(() => service.setSourceEnabled(source.id, !source.enabled)),
    translate('generated.skillSourceManagementPage.skillSourceStatusUpdated')
  );
}

async function addToCatalog(): Promise<void> {
  if (
    !(await catalogForm.value?.validate().catch(() => false)) ||
    pendingCandidate.value === undefined
  )
    return;
  const tags = catalogDraft.tags.map((tag) => tag.trim());
  await run(async () => {
    await service.favorite(pendingCandidate.value!, { featured: catalogDraft.featured, tags });
    catalogDialog.value = false;
  }, translate('generated.skillSourceManagementPage.skillAddedToTheCatalog'));
}

async function checkSkillUpdate(skill: (typeof service.favorites.value)[number]): Promise<void> {
  checkingSkillIds.value = new Set([...checkingSkillIds.value, skill.id]);
  try {
    await run(async () => {
      const result = await service.checkUpdate(skill.id);
      updateChecks.value = { ...updateChecks.value, [skill.id]: result };
      showMessage(
        result.updateAvailable
          ? translate('generated.skillSourceManagementPage.updateAvailable')
          : translate('generated.skillSourceManagementPage.alreadyUpToDate'),
        'info'
      );
    });
  } finally {
    const remaining = new Set(checkingSkillIds.value);
    remaining.delete(skill.id);
    checkingSkillIds.value = remaining;
  }
}

async function upgradeSkill(skill: (typeof service.favorites.value)[number]): Promise<void> {
  upgradingSkillId.value = skill.id;
  try {
    await run(async () => {
      await service.upgrade(skill.id);
      const remaining = { ...updateChecks.value };
      delete remaining[skill.id];
      updateChecks.value = remaining;
    }, translate('generated.skillSourceManagementPage.catalogSkillUpdated'));
  } finally {
    upgradingSkillId.value = undefined;
  }
}

function formatUpdatedAt(timestamp: number): string {
  return managementDateTime(timestamp);
}

async function removeSource(source: SkillSourceCard): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.skillSourceManagementPage.deleteSkillSource', { value0: source.name }),
      translate('generated.skillSourceManagementPage.deleteSkillSource2'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.skillSourceManagementPage.delete'),
        cancelButtonText: translate('generated.skillSourceManagementPage.cancel')
      }
    );
  } catch (error) {
    if (isDialogCancellation(error)) return;
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillSourceManagementPage.unableToConfirmDeletionTryAgainLater')
      ),
      'error',
      error
    );
    return;
  }
  await run(
    () => mutateSource(() => service.removeSource(source.id)),
    translate('generated.skillSourceManagementPage.skillSourceDeleted')
  );
}

async function removeSkill(id: string, name: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('generated.skillSourceManagementPage.removeFromTheSkillCatalogInstalledCopies', {
        value0: name
      }),
      translate('generated.skillSourceManagementPage.removeSkill'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.skillSourceManagementPage.remove'),
        cancelButtonText: translate('generated.skillSourceManagementPage.cancel2')
      }
    );
  } catch (error) {
    if (isDialogCancellation(error)) return;
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillSourceManagementPage.unableToConfirmRemovalTryAgainLater')
      ),
      'error',
      error
    );
    return;
  }
  await run(
    () => service.remove(id),
    translate('generated.skillSourceManagementPage.skillRemoved')
  );
}

function isDialogCancellation(error: unknown): boolean {
  return error === 'cancel' || error === 'close';
}

function scopeLabel(scope: string): string {
  return props.scopeLabel?.(scope) ?? translate('generated.skillSourceManagementPage.personal');
}
</script>

<template>
  <section
    v-loading="initialLoading"
    element-loading-custom-class="mar-page-loading"
    class="management-page"
  >
    <div class="table-actions">
      <el-button
        type="primary"
        :icon="marIcon('plus')"
        :disabled="!writable || service.loading.value"
        @click="openSourceDialog"
        >{{ translate('generated.skillSourceManagementPage.addSkillSource') }}</el-button
      >
    </div>
    <el-table
      class="clickable-rows skill-source-table"
      :data="displayedSources"
      row-key="id"
      @row-click="showSourceDetails"
    >
      <el-table-column
        prop="name"
        :label="translate('generated.skillSourceManagementPage.name')"
        sortable
        min-width="180"
      />
      <el-table-column
        :label="translate('generated.skillSourceManagementPage.scope')"
        width="100"
        sortable
        :sort-method="
          (a: SkillSourceCard, b: SkillSourceCard) =>
            scopeLabel(a.scope).localeCompare(scopeLabel(b.scope))
        "
        ><template #default="{ row }">{{ scopeLabel(row.scope) }}</template></el-table-column
      >
      <el-table-column
        prop="locator"
        :label="translate('generated.skillSourceManagementPage.uRL')"
        min-width="280"
        show-overflow-tooltip
      />
      <el-table-column :label="translate('generated.skillSourceManagementPage.status')" width="110"
        ><template #default="{ row }"
          ><el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">{{
            row.enabled
              ? translate('generated.skillSourceManagementPage.enabled')
              : translate('generated.skillSourceManagementPage.disabled')
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column
        :label="translate('generated.skillSourceManagementPage.actions')"
        :width="180"
        ><template #default="{ row }">
          <div class="row-actions" @click.stop>
            <el-button
              link
              type="primary"
              :icon="marIcon('power')"
              :disabled="!writable || !row.manageable || service.loading.value"
              @click="confirmSourceStatusChange(row)"
              >{{
                row.enabled
                  ? translate('generated.skillSourceManagementPage.disable')
                  : translate('generated.skillSourceManagementPage.enable')
              }}</el-button
            >
            <el-button
              v-if="!row.builtIn"
              link
              type="danger"
              :icon="marIcon('delete')"
              :disabled="!writable || !row.manageable || service.loading.value"
              @click="removeSource(row)"
              >{{ translate('generated.skillSourceManagementPage.delete2') }}</el-button
            >
          </div>
        </template></el-table-column
      >
    </el-table>

    <el-tabs v-model="activeSkillTab" class="skill-management-tabs">
      <el-tab-pane
        :label="translate('generated.skillSourceManagementPage.sourceSkills')"
        name="source"
      >
        <div class="source-search-bar">
          <el-select
            :model-value="service.selectedSourceId.value"
            :aria-label="translate('generated.skillSourceManagementPage.selectASkillSource')"
            :placeholder="
              translate('generated.skillSourceManagementPage.selectAnEnabledSkillSource')
            "
            :disabled="service.loading.value"
            @change="selectSource"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="source in service.sources.value.filter((item) => item.enabled)"
              :key="source.id"
              :label="source.name"
              :value="source.id"
            />
          </el-select>
          <div class="toolbar">
            <el-input
              v-model="service.query.value"
              clearable
              :placeholder="
                translate('generated.skillSourceManagementPage.enterASkillNameOrDescription')
              "
              @keyup.enter="run(searchSourceSkills)"
              :clear-icon="marIcon('clear-input')"
            >
              <template #append>
                <el-button
                  :icon="marIcon('search')"
                  :disabled="!selectedSource?.enabled || service.loading.value"
                  @click="run(searchSourceSkills)"
                  >{{ translate('generated.skillSourceManagementPage.search') }}</el-button
                >
              </template>
            </el-input>
          </div>
        </div>
        <div v-loading="sourceSkillsLoading && !initialLoading" class="skill-table-section">
          <el-table
            v-if="service.candidates.value.length > 0"
            class="clickable-rows source-skill-table"
            :data="service.candidates.value"
            row-key="id"
            @row-click="showCandidateDetails"
          >
            <el-table-column
              prop="name"
              :label="translate('generated.skillSourceManagementPage.name')"
              sortable
              min-width="180"
            />
            <el-table-column
              prop="source"
              :label="translate('generated.skillDetailsDialog.source')"
              min-width="180"
              show-overflow-tooltip
            />
            <el-table-column
              prop="description"
              :label="translate('conversationTemplates.description')"
              min-width="280"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                {{
                  row.description ||
                  translate(
                    'generated.skillSourceManagementPage.noDescriptionWasProvidedByThisSource'
                  )
                }}
              </template>
            </el-table-column>
            <el-table-column
              :label="translate('generated.skillSourceManagementPage.actions')"
              :width="180"
            >
              <template #default="{ row }">
                <div class="row-actions" @click.stop>
                  <el-button
                    link
                    type="primary"
                    :icon="marIcon('plus')"
                    :disabled="!writable || service.loading.value"
                    @click="openCatalogDialog(row)"
                    >{{ translate('generated.skillSourceManagementPage.addToCatalog') }}</el-button
                  >
                </div>
              </template>
            </el-table-column>
          </el-table>
          <div v-else-if="!service.loading.value" class="skill-empty">
            {{
              selectedSource?.kind === 'SKILLS_SH'
                ? translate('generated.skillSourceManagementPage.noPopularSkillsAreAvailableEnterA')
                : selectedSource
                  ? translate('generated.skillSourceManagementPage.thisSourceHasNoAvailableSkills')
                  : translate('generated.skillSourceManagementPage.selectAnEnabledSkillSource2')
            }}
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane
        :label="translate('generated.skillSourceManagementPage.catalogSkills')"
        name="catalog"
      >
        <div class="catalog-filter-bar">
          <el-input
            v-model="catalogQuery"
            clearable
            :placeholder="
              translate('generated.skillSourceManagementPage.searchSkillNamesOrDescriptions')
            "
            :clear-icon="marIcon('clear-input')"
          />
          <div
            class="skill-category-strip"
            :aria-label="translate('generated.skillSourceManagementPage.catalogSkillCategories')"
          >
            <button
              :class="{ selected: selectedCatalogCategory === '' }"
              @click="selectedCatalogCategory = ''"
            >
              {{ translate('generated.skillSourceManagementPage.all') }}
            </button>
            <button
              v-for="tag in catalogTags"
              :key="tag"
              :class="{ selected: selectedCatalogCategory === tag }"
              @click="selectedCatalogCategory = tag"
            >
              {{ tag }}
            </button>
          </div>
        </div>
        <div
          v-loading="pagination.loading.value && !initialLoading && !pagination.loadingMore.value"
          class="skill-table-section"
        >
          <el-table
            v-if="filteredFavorites.length > 0"
            class="clickable-rows catalog-skill-table"
            @sort-change="pagination.sort"
            :data="filteredFavorites"
            row-key="id"
            @row-click="showFavoriteDetails"
          >
            <el-table-column
              prop="normalizedName"
              :label="translate('generated.skillSourceManagementPage.name')"
              sortable="custom"
              min-width="170"
            />
            <el-table-column
              prop="repositoryIdentity"
              :label="translate('generated.skillDetailsDialog.source')"
              min-width="180"
              show-overflow-tooltip
            />
            <el-table-column
              :label="translate('generated.skillSourceManagementPage.scope')"
              width="100"
            >
              <template #default="{ row }">{{ scopeLabel(row.scope) }}</template>
            </el-table-column>
            <el-table-column
              prop="description"
              :label="translate('conversationTemplates.description')"
              min-width="260"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                {{
                  row.description ||
                  translate(
                    'generated.skillSourceManagementPage.noDescriptionIsAvailableForThisSkill'
                  )
                }}
              </template>
            </el-table-column>
            <el-table-column
              :label="translate('generated.skillDetailsDialog.version')"
              min-width="170"
            >
              <template #default="{ row }">
                <span>{{ row.commitSha.slice(0, 8) }}</span>
                <span class="table-meta">
                  {{ translate('generated.skillSourceManagementPage.updated') }}
                  {{ formatUpdatedAt(row.updatedAt) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              :label="translate('generated.skillDetailsDialog.tags')"
              min-width="150"
            >
              <template #default="{ row }">
                <div v-if="row.featured || row.tags.length > 0" class="skill-tags">
                  <el-tag v-if="row.featured" type="warning" effect="plain"
                    >★ {{ translate('generated.skillSourceManagementPage.featured') }}</el-tag
                  >
                  <el-tag v-for="tag in row.tags" :key="tag" type="info" effect="plain">{{
                    tag
                  }}</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              :label="translate('generated.skillSourceManagementPage.actions')"
              min-width="360"
            >
              <template #default="{ row }">
                <div class="row-actions" @click.stop>
                  <el-button
                    link
                    type="primary"
                    :icon="marIcon('edit')"
                    :disabled="!writable || !row.manageable || service.loading.value"
                    @click="openEditDialog(row)"
                    >{{ translate('generated.skillSourceManagementPage.edit') }}</el-button
                  >
                  <el-button
                    v-if="!updateChecks[row.id]?.updateAvailable"
                    link
                    :icon="marIcon('refresh')"
                    :loading="checkingSkillIds.has(row.id)"
                    :disabled="!writable || !row.manageable || service.loading.value"
                    @click="checkSkillUpdate(row)"
                    :loading-icon="marIcon('loading-action')"
                    >{{
                      translate('generated.skillSourceManagementPage.checkForUpdates')
                    }}</el-button
                  >
                  <el-button
                    v-else
                    link
                    type="primary"
                    :icon="marIcon('retry')"
                    :loading="upgradingSkillId === row.id"
                    :disabled="!writable || !row.manageable || service.loading.value"
                    @click="upgradeSkill(row)"
                    :loading-icon="marIcon('loading-action')"
                    >{{ translate('generated.skillSourceManagementPage.updateTo') }}
                    {{ updateChecks[row.id]!.latestCommitSha.slice(0, 8) }}</el-button
                  >
                  <el-button
                    link
                    type="danger"
                    :icon="marIcon('delete')"
                    :disabled="!writable || !row.manageable || service.loading.value"
                    @click="removeSkill(row.id, row.normalizedName)"
                    >{{ translate('generated.skillSourceManagementPage.remove2') }}</el-button
                  >
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div v-else-if="!service.loading.value" class="skill-empty">
            {{
              service.favorites.value.length === 0
                ? translate('generated.skillSourceManagementPage.noCatalogSkills')
                : translate('generated.skillSourceManagementPage.noMatchingSkills')
            }}
          </div>
          <ManagementPagination
            :total="pagination.total.value"
            :page="pagination.page.value"
            :mobile="pagination.mobileViewport.value"
            :mobile-visible-count="pagination.mobileVisibleCount.value"
            :loading="pagination.loading.value"
            :loading-more="pagination.loadingMore.value"
            :has-more="pagination.hasMore.value"
            @page="pagination.setPage"
            @load-more="pagination.loadMore"
          />
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-if="sourceDialog"
      v-model="sourceDialog"
      :title="translate('generated.skillSourceManagementPage.addSkillSource2')"
      width="min(520px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <el-form
        ref="sourceForm"
        :model="{ ...sourceContext, ...sourceDraft }"
        :rules="{ ...ownershipRules, ...rules }"
        label-position="top"
      >
        <el-form-item :label="translate('generated.skillSourceManagementPage.name2')" prop="name"
          ><el-input v-model="sourceDraft.name" maxlength="128"
        /></el-form-item>
        <el-form-item
          :label="translate('generated.skillSourceManagementPage.repositoryURL')"
          prop="locator"
          ><el-input
            v-model="sourceDraft.locator"
            :placeholder="
              translate('generated.skillSourceManagementPage.httpsGithubComOrgRepoOrGit')
            "
        /></el-form-item>
        <p class="form-hint">
          {{
            translate('generated.skillSourceManagementPage.gitRepositoriesUseTheServerProcessUser')
          }}
        </p>
        <slot name="source-ownership">
          <el-form-item :label="translate('generated.skillSourceManagementPage.scope2')">
            <el-select
              model-value="PERSONAL"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
              ><el-option
                value="PERSONAL"
                :label="translate('generated.skillSourceManagementPage.personal2')"
            /></el-select>
          </el-form-item>
        </slot>
      </el-form>
      <template #footer
        ><el-button @click="sourceDialog = false">{{
          translate('generated.skillSourceManagementPage.cancel3')
        }}</el-button
        ><el-button
          type="primary"
          :loading="service.loading.value"
          @click="addSource"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('generated.skillSourceManagementPage.add') }}</el-button
        ></template
      >
    </el-dialog>

    <el-dialog
      v-if="catalogDialog"
      v-model="catalogDialog"
      :title="translate('generated.skillSourceManagementPage.addToCatalog2')"
      width="min(460px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <el-form
        ref="catalogForm"
        :model="{ ...catalogContext, ...catalogDraft }"
        :rules="{ ...ownershipRules, ...rules }"
        label-position="top"
      >
        <slot name="catalog-ownership">
          <el-form-item :label="translate('generated.skillSourceManagementPage.availability')">
            <el-select
              model-value="PERSONAL"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
              ><el-option
                value="PERSONAL"
                :label="translate('generated.skillSourceManagementPage.personal3')"
            /></el-select>
          </el-form-item>
        </slot>
        <el-form-item :label="translate('generated.skillSourceManagementPage.featured2')">
          <el-switch v-model="catalogDraft.featured" />
        </el-form-item>
        <el-form-item :label="translate('generated.skillSourceManagementPage.tags')" prop="tags">
          <el-select
            v-model="catalogDraft.tags"
            multiple
            filterable
            allow-create
            default-first-option
            :multiple-limit="10"
            :placeholder="translate('generated.skillSourceManagementPage.enterATagAndPressEnterUp')"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option v-for="tag in catalogTags" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer
        ><el-button @click="catalogDialog = false">{{
          translate('generated.skillSourceManagementPage.cancel4')
        }}</el-button
        ><el-button
          type="primary"
          :loading="service.loading.value"
          @click="addToCatalog"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('generated.skillSourceManagementPage.add2') }}</el-button
        ></template
      >
    </el-dialog>

    <el-dialog
      v-if="editDialog"
      v-model="editDialog"
      :title="translate('generated.skillSourceManagementPage.editSkillInformation')"
      width="min(460px, calc(100vw - 32px))"
      destroy-on-close
      :close-icon="marIcon('close')"
    >
      <el-form ref="editForm" :model="editDraft" :rules="rules" label-position="top">
        <el-form-item :label="translate('generated.skillSourceManagementPage.featured3')">
          <el-switch v-model="editDraft.featured" />
        </el-form-item>
        <el-form-item :label="translate('generated.skillSourceManagementPage.tags2')" prop="tags">
          <el-select
            v-model="editDraft.tags"
            multiple
            filterable
            allow-create
            default-first-option
            :multiple-limit="10"
            :placeholder="
              translate('generated.skillSourceManagementPage.enterATagAndPressEnterUp2')
            "
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option v-for="tag in catalogTags" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialog = false">{{
          translate('generated.skillSourceManagementPage.cancel5')
        }}</el-button>
        <el-button
          type="primary"
          :loading="service.loading.value"
          @click="savePresentation"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('generated.skillSourceManagementPage.save') }}</el-button
        >
      </template>
    </el-dialog>
    <SkillDetailsDialog v-model="detailsOpen" :details="skillDetails" />
  </section>
</template>

<style scoped>
.management-page > * {
  flex-shrink: 0;
  min-width: 0;
}
.skill-management-tabs {
  min-height: 260px;
  min-width: 0;
}
.skill-management-tabs :deep(.el-tabs__content) {
  min-width: 0;
}
.skill-management-tabs :deep(.el-tab-pane) {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.section-heading h3 {
  margin: 0;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--mar-fill-hover);
  padding-top: 14px;
}
.section-heading p {
  margin: 2px 0 0;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
.source-search-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.source-search-bar :deep(.el-select) {
  width: min(320px, 100%);
  min-width: 200px;
}
.toolbar {
  flex: 1 1 420px;
  min-width: 0;
  max-width: 620px;
}
.catalog-filter-bar {
  display: grid;
  gap: 10px;
}
.catalog-filter-bar :deep(.el-input) {
  width: min(620px, 100%);
}
.skill-category-strip {
  display: flex;
  overflow-x: auto;
  gap: 6px;
  padding: 1px 0 3px;
  scrollbar-width: thin;
}
.skill-category-strip button {
  flex: none;
  border: 1px solid var(--mar-border-medium);
  border-radius: 999px;
  background: var(--mar-bg-panel);
  color: var(--mar-text-tertiary);
  padding: 5px 12px;
  font: inherit;
  font-size: var(--mar-font-size-body);
  cursor: pointer;
}
.skill-category-strip button:hover {
  border-color: var(--mar-text-faint);
  color: var(--mar-color-brand-text);
}
.skill-category-strip button.selected {
  border-color: var(--mar-color-brand);
  background: var(--el-color-primary-light-9);
  color: var(--mar-color-brand-text);
  font-weight: 600;
}
.skill-category-strip button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
.form-hint {
  margin: -8px 0 14px;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}
.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.skill-table-section {
  min-height: 180px;
  min-width: 0;
}
.skill-empty {
  border: 1px dashed var(--mar-border-medium);
  border-radius: 8px;
  background: var(--mar-bg-subtle);
  padding: 20px;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-body);
  text-align: center;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.table-meta {
  display: block;
  margin-top: 2px;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
@media (max-width: 700px) {
  .source-search-bar {
    align-items: stretch;
    flex-direction: column;
  }
  .source-search-bar :deep(.el-select) {
    width: 100%;
  }
  .toolbar :deep(.el-button),
  .section-heading :deep(.el-button) {
    min-height: 36px;
  }
}
</style>
