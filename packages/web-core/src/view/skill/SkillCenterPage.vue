<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { ElMessageBox } from '../../service/message-box-service.js';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  createSkillCenterService,
  type InstalledSkillCard
} from '../../service/skill-center-service.js';
import { skillErrorMessage } from '../../util/skill-errors.js';
import SkillDetailsDialog, { type SkillDetails } from './SkillDetailsDialog.vue';
import McpCenterPanel from './McpCenterPanel.vue';
import ManagementPagination from '../settings/ManagementPagination.vue';
import { translate } from '../../service/locale-preference-service.js';
import { errorCode } from '../../util/api-error.js';

const props = defineProps<{
  readonly scopeLabel?: (scope: string) => string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  nodes: readonly {
    readonly id: string;
    readonly displayName: string | null;
    readonly registeredAddress: string;
    readonly connected: boolean;
    readonly disabled: boolean;
    readonly nodeAppVersion: string;
  }[];
}>();
const service = createSkillCenterService(props.request);
const targetKind = ref<'NODE' | 'WORKSPACE'>('NODE');
const targetNodeId = ref('');
const targetWorkspaceId = ref('');
const targetMutationPending = ref(false);
const installingFavoriteId = ref<string>();
const showInstallProgress = ref(false);
const skillQuery = service.catalogPage.keyword;
const selectedCategory = service.catalogPage.category;
const activeConfigTab = ref<'available' | 'installed'>('available');
const availablePagination = service.catalogPage;
const catalogReady = ref(false);
const detailsOpen = ref(false);
const skillDetails = ref<SkillDetails>();
const capabilityTab = ref<'skill' | 'mcp'>('skill');
let targetsLoaded = false;
let targetsLoading: Promise<void> | undefined;
let activeInspection: { readonly key: string; readonly operation: Promise<void> } | undefined;
const managedNodeIds = computed(
  () => new Set(service.managedTargets.value.nodes.map((node) => node.id))
);
const targetNodes = computed(() => props.nodes.filter((node) => managedNodeIds.value.has(node.id)));
const targetNode = computed(() => targetNodes.value.find((node) => node.id === targetNodeId.value));
const targetWorkspaces = computed(() =>
  service.managedTargets.value.workspaces.filter(
    (workspace) => workspace.nodeId === targetNodeId.value
  )
);
const effectiveWorkspaceId = computed(() =>
  targetKind.value === 'WORKSPACE' && targetWorkspaceId.value !== ''
    ? targetWorkspaceId.value
    : undefined
);
const targetReady = computed(
  () =>
    targetNode.value !== undefined &&
    targetNode.value.connected &&
    !targetNode.value.disabled &&
    (targetKind.value === 'NODE' || effectiveWorkspaceId.value !== undefined)
);
const availableTags = service.catalogPage.tags;
const filteredFavorites = service.favorites;
const installedSkills = computed(() => service.target.value?.skills ?? []);
const displayedFavorites = filteredFavorites;
// Installed skills are the Node's complete target snapshot, not directory pages.
const displayedInstalledSkills = installedSkills;

onMounted(() => {
  availablePagination.start();
  void run(service.loadCatalog);
});
onUnmounted(() => {
  availablePagination.dispose();
});
watch(availablePagination.result, (result) => {
  if (result !== undefined) catalogReady.value = true;
});
watch(
  [targetNodeId, targetWorkspaceId, targetKind],
  () =>
    void run(async () => {
      await ensureTargets();
      await inspectTarget();
    }),
  { immediate: true }
);
watch(targetNodes, (nodes) => {
  if (nodes.some((node) => node.id === targetNodeId.value)) return;
  const firstOnline = nodes.find((node) => node.connected && !node.disabled);
  targetNodeId.value = firstOnline?.id ?? nodes[0]?.id ?? '';
  selectTargetNode();
});
watch(activeConfigTab, (tab) => {
  if (tab === 'available') void run(service.loadCatalog);
});
async function ensureTargets(): Promise<void> {
  if (targetsLoaded) return;
  if (targetsLoading !== undefined) return targetsLoading;
  targetsLoading = (async () => {
    await service.loadManagedTargets();
    targetsLoaded = true;
    if (!targetNodes.value.some((node) => node.id === targetNodeId.value)) {
      const firstOnline = targetNodes.value.find((node) => node.connected && !node.disabled);
      targetNodeId.value = firstOnline?.id ?? targetNodes.value[0]?.id ?? '';
      selectTargetNode();
    }
  })();
  try {
    await targetsLoading;
  } finally {
    targetsLoading = undefined;
  }
}

async function run(operation: () => Promise<void>, success?: string): Promise<void> {
  try {
    await operation();
    if (success !== undefined) showMessage(success, 'success');
  } catch (error) {
    if (error === service.catalogPage.error.value) return;
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillCenterPage.theSkillOperationDidNotCompleteTry')
      ),
      'error',
      error
    );
  }
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

function showInstalledDetails(skill: InstalledSkillCard): void {
  const favorite = matchingFavorite(skill);
  skillDetails.value = {
    name: skill.name,
    description: skill.description,
    status: statusLabel(skill),
    ...(skill.install === undefined ? {} : { version: skill.install.commitSha.slice(0, 8) }),
    ...(favorite === undefined
      ? {}
      : {
          source: favorite.repositoryIdentity,
          path: favorite.skillPath,
          featured: favorite.featured,
          tags: favorite.tags
        })
  };
  detailsOpen.value = true;
}

function formatUpdatedAt(timestamp: number): string {
  return managementDateTime(timestamp);
}

async function inspectTarget(): Promise<void> {
  if (!targetReady.value || targetNodeId.value === '') {
    service.clearTarget();
    return;
  }
  const nodeId = targetNodeId.value;
  const workspaceId = effectiveWorkspaceId.value;
  const key = `${nodeId}:${workspaceId ?? ''}`;
  if (activeInspection?.key === key) return activeInspection.operation;
  const operation = service.inspectTarget(nodeId, workspaceId);
  activeInspection = { key, operation };
  try {
    await operation;
  } finally {
    if (activeInspection?.operation === operation) activeInspection = undefined;
  }
}

async function checkEnvironment(): Promise<void> {
  if (!targetReady.value || targetNodeId.value === '') return;
  try {
    await inspectTarget();
    const target = service.target.value;
    if (target === undefined) return;
    const issues = target.skills.filter((skill) => skill.localStatus !== 'VALID').length;
    const compatibility =
      target.compatibilityMode === 'SYMLINK'
        ? translate('generated.skillCenterPage.compatibleLink')
        : target.compatibilityMode === 'JUNCTION'
          ? translate('generated.skillCenterPage.directoryJunction')
          : target.compatibilityMode === 'MANAGED_COPY'
            ? translate('generated.skillCenterPage.managedCopy')
            : translate('generated.skillCenterPage.unavailable');
    await ElMessageBox.alert(
      translate('generated.skillCenterPage.environmentModeSkillsFoundRequireAttention', {
        value0: compatibility,
        value1: target.skills.length,
        value2: issues
      }),
      issues > 0
        ? translate('generated.skillCenterPage.environmentCheckFoundIssues')
        : translate('generated.skillCenterPage.environmentCheckPassed'),
      {
        closeIcon: marIcon('close'),
        confirmButtonText: translate('generated.skillCenterPage.oK'),
        icon: marIcon(issues > 0 ? 'warning' : 'success'),
        type: issues > 0 ? 'warning' : 'success'
      }
    );
  } catch (error) {
    if (!isDialogCancellation(error))
      showMessage(
        skillErrorMessage(
          error,
          translate('generated.skillCenterPage.theEnvironmentCheckDidNotCompleteTry')
        ),
        'error',
        error
      );
  }
}

function selectTargetNode(): void {
  const firstWorkspace = targetWorkspaces.value[0];
  targetWorkspaceId.value = firstWorkspace?.workspaceId ?? '';
}

function selectTargetKind(): void {
  if (targetKind.value === 'WORKSPACE' && targetWorkspaceId.value === '') selectTargetNode();
}

function installedFor(favoriteId: string, name: string): InstalledSkillCard | undefined {
  return service.target.value?.skills.find(
    (skill) => skill.install?.favoriteId === favoriteId || skill.name === name
  );
}

function installLabel(favorite: (typeof service.favorites.value)[number]): string {
  if (targetMutationPending.value && installingFavoriteId.value === favorite.id)
    return translate('generated.skillCenterPage.installing');
  const installed = installedFor(favorite.id, favorite.normalizedName);
  if (installed === undefined) return translate('generated.skillCenterPage.install');
  return installed.install?.versionId === favorite.currentVersionId
    ? translate('generated.skillCenterPage.reinstall')
    : translate('generated.skillCenterPage.update');
}

async function install(favorite: (typeof service.favorites.value)[number]): Promise<void> {
  if (!targetReady.value || targetNodeId.value === '' || targetMutationPending.value) return;
  const nodeId = targetNodeId.value;
  const workspaceId = effectiveWorkspaceId.value;
  const targetKey = `${nodeId}:${workspaceId ?? ''}`;
  const overwrite = installedFor(favorite.id, favorite.normalizedName) !== undefined;
  const installed = installedFor(favorite.id, favorite.normalizedName);
  let operationStarted = false;
  let progressTimer: number | undefined;
  try {
    if (overwrite && installed?.localStatus !== 'INVALID_LINK')
      await ElMessageBox.confirm(
        translate('generated.skillCenterPage.reinstallingWillOverwriteExistingFilesForManual', {
          value0: favorite.normalizedName
        }),
        translate('generated.skillCenterPage.overwriteSkill'),
        {
          closeIcon: marIcon('close'),
          icon: marIcon('warning'),
          type: 'warning',
          confirmButtonText: translate('generated.skillCenterPage.continue'),
          cancelButtonText: translate('generated.skillCenterPage.cancel')
        }
      );
    targetMutationPending.value = true;
    installingFavoriteId.value = favorite.id;
    showInstallProgress.value = false;
    progressTimer = window.setTimeout(() => {
      if (installingFavoriteId.value === favorite.id) showInstallProgress.value = true;
    }, 800);
    operationStarted = true;
    await service.install(favorite.id, nodeId, workspaceId, overwrite);
    showMessage(
      overwrite
        ? translate('generated.skillCenterPage.skillUpdated')
        : translate('generated.skillCenterPage.skillInstalled'),
      'success'
    );
  } catch (error) {
    if (isDialogCancellation(error)) return;
    if (
      workspaceId !== undefined &&
      errorCode(error) === 'WORKSPACE_SKILL_TRACKED_CONFIRM_REQUIRED'
    ) {
      try {
        await ElMessageBox.confirm(
          translate('generated.skillCenterPage.theTargetContainsGitTrackedFilesOverwritten'),
          translate('generated.skillCenterPage.overwriteTrackedFiles'),
          {
            closeIcon: marIcon('close'),
            icon: marIcon('warning'),
            type: 'warning',
            confirmButtonText: translate('generated.skillCenterPage.overwriteFiles'),
            cancelButtonText: translate('generated.skillCenterPage.cancel2')
          }
        );
        await service.install(favorite.id, nodeId, workspaceId, true);
        showMessage(translate('generated.skillCenterPage.skillInstalled2'), 'success', error);
      } catch (confirmationError) {
        if (!isDialogCancellation(confirmationError))
          showMessage(
            skillErrorMessage(
              confirmationError,
              translate('generated.skillCenterPage.skillInstallationDidNotCompleteTryAgain')
            ),
            'error',
            confirmationError
          );
      }
      return;
    }
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillCenterPage.skillInstallationDidNotCompleteTryAgain2')
      ),
      'error',
      error
    );
  } finally {
    if (progressTimer !== undefined) window.clearTimeout(progressTimer);
    targetMutationPending.value = false;
    installingFavoriteId.value = undefined;
    showInstallProgress.value = false;
    if (
      operationStarted &&
      `${targetNodeId.value}:${effectiveWorkspaceId.value ?? ''}` === targetKey
    )
      await inspectTarget();
  }
}

function matchingFavorite(skill: InstalledSkillCard) {
  const exact = service.installedFavorites.value.find(
    (favorite) => favorite.id === skill.install?.favoriteId
  );
  return (
    exact ??
    service.installedFavorites.value.find((favorite) => favorite.normalizedName === skill.name)
  );
}

function statusLabel(skill: InstalledSkillCard): string {
  if (skill.localStatus !== 'VALID') {
    if (skill.localStatus === 'UNKNOWN_VERSION')
      return translate('generated.skillCenterPage.unknownVersion');
    if (skill.localStatus === 'PARTIAL')
      return translate('generated.skillCenterPage.incompleteInstallation');
    if (skill.localStatus === 'GIT_EXCLUDE_BROKEN')
      return translate('generated.skillCenterPage.gitRulesNeedRepair');
    return translate('generated.skillCenterPage.directoryError');
  }
  const favorite = matchingFavorite(skill);
  if (favorite === undefined || skill.install === undefined)
    return translate('generated.skillCenterPage.unknownVersion2');
  return favorite.commitSha === skill.install.commitSha
    ? translate('generated.skillCenterPage.upToDate')
    : translate('generated.skillCenterPage.updateAvailable');
}

async function removeInstalled(name: string): Promise<void> {
  if (targetNodeId.value === '' || targetMutationPending.value) return;
  try {
    await ElMessageBox.confirm(
      translate('generated.skillCenterPage.deleteFromTheCurrentTargetTheSystem', { value0: name }),
      translate('generated.skillCenterPage.deleteSkill'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.skillCenterPage.deleteDirectory'),
        cancelButtonText: translate('generated.skillCenterPage.cancel3')
      }
    );
  } catch (error) {
    if (isDialogCancellation(error)) return;
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillCenterPage.unableToConfirmDeletionTryAgainLater')
      ),
      'error',
      error
    );
    return;
  }
  await mutateCurrentTarget(
    () => service.removeInstalled(name, targetNodeId.value, effectiveWorkspaceId.value),
    translate('generated.skillCenterPage.skillDeleted')
  );
}

async function repairGitExclude(): Promise<void> {
  if (
    targetNodeId.value === '' ||
    effectiveWorkspaceId.value === undefined ||
    targetMutationPending.value
  )
    return;
  try {
    await ElMessageBox.confirm(
      translate('generated.skillCenterPage.repairingTheEnvironmentUpdatesTheWorkspaceS'),
      translate('generated.skillCenterPage.repairSkillEnvironment'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.skillCenterPage.repair'),
        cancelButtonText: translate('generated.skillCenterPage.cancel4')
      }
    );
  } catch (error) {
    if (isDialogCancellation(error)) return;
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillCenterPage.unableToConfirmRepairTryAgainLater')
      ),
      'error',
      error
    );
    return;
  }
  await mutateCurrentTarget(
    () => service.repairGitExclude(targetNodeId.value, effectiveWorkspaceId.value!),
    translate('generated.skillCenterPage.localGitExcludeRulesRepaired')
  );
}

async function mutateCurrentTarget(operation: () => Promise<void>, success: string): Promise<void> {
  const targetKey = `${targetNodeId.value}:${effectiveWorkspaceId.value ?? ''}`;
  targetMutationPending.value = true;
  try {
    await operation();
    showMessage(success, 'success');
  } catch (error) {
    showMessage(
      skillErrorMessage(
        error,
        translate('generated.skillCenterPage.theSkillOperationDidNotCompleteTry2')
      ),
      'error',
      error
    );
  } finally {
    targetMutationPending.value = false;
    if (`${targetNodeId.value}:${effectiveWorkspaceId.value ?? ''}` === targetKey)
      await inspectTarget();
  }
}

function isDialogCancellation(error: unknown): boolean {
  return error === 'cancel' || error === 'close';
}

function scopeLabel(scope: string): string {
  return props.scopeLabel?.(scope) ?? translate('generated.skillCenterPage.personal');
}
</script>

<template>
  <section
    class="skill-page"
    :aria-label="translate('generated.skillCenterPage.skillConfiguration')"
  >
    <header class="skill-page-header">
      <div>
        <p>{{ translate('generated.skillCenterPage.installAndMaintainSkillsForNodesOr') }}</p>
      </div>
    </header>

    <el-tabs v-model="capabilityTab" class="capability-tabs">
      <el-tab-pane :label="translate('common.skill')" name="skill" />
      <el-tab-pane :label="translate('common.mcp')" name="mcp" />
    </el-tabs>

    <McpCenterPanel
      :scope-label="scopeLabel"
      v-if="capabilityTab === 'mcp'"
      :request="request"
      :nodes="nodes"
    />

    <section v-else class="skill-content">
      <section
        class="target-panel"
        :aria-label="translate('generated.skillCenterPage.skillConfigurationTarget')"
      >
        <div>
          <strong>{{ translate('generated.skillCenterPage.configurationTarget') }}</strong
          ><span>{{ translate('generated.skillCenterPage.selectWhereTheSkillWillBeUsed') }}</span>
        </div>
        <el-segmented
          v-model="targetKind"
          :options="[
            { label: translate('generated.skillCenterPage.node'), value: 'NODE' },
            { label: translate('generated.skillCenterPage.workspace'), value: 'WORKSPACE' }
          ]"
          @change="selectTargetKind"
        />
        <el-select
          v-model="targetNodeId"
          class="target-select"
          :placeholder="translate('generated.skillCenterPage.selectANode')"
          :aria-label="translate('generated.skillCenterPage.skillNode')"
          @change="selectTargetNode"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="node in targetNodes"
            :key="node.id"
            :value="node.id"
            :label="node.displayName || node.registeredAddress || node.id"
            :disabled="!node.connected || node.disabled"
          >
            <span>{{ node.displayName || node.registeredAddress || node.id }}</span>
            <span class="target-option-state">{{
              node.disabled
                ? translate('generated.skillCenterPage.disabled')
                : node.connected
                  ? translate('generated.skillCenterPage.online')
                  : translate('generated.skillCenterPage.offline')
            }}</span>
          </el-option>
        </el-select>
        <el-select
          v-if="targetKind === 'WORKSPACE'"
          v-model="targetWorkspaceId"
          class="target-select"
          :placeholder="translate('generated.skillCenterPage.selectAWorkspace')"
          :aria-label="translate('generated.skillCenterPage.skillWorkspace')"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="workspace in targetWorkspaces"
            :key="workspace.workspaceId"
            :value="workspace.workspaceId"
            :label="workspace.displayName"
          />
        </el-select>
        <el-button
          :icon="marIcon('refresh')"
          :disabled="!targetReady || service.targetLoading.value"
          :loading="service.targetLoading.value && activeConfigTab !== 'installed'"
          @click="checkEnvironment"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('generated.skillCenterPage.checkEnvironment') }}</el-button
        >
        <el-button
          v-if="targetKind === 'WORKSPACE'"
          :icon="marIcon('tool')"
          :disabled="!targetReady || targetMutationPending"
          @click="repairGitExclude"
          >{{ translate('generated.skillCenterPage.repairEnvironment') }}</el-button
        >
      </section>
      <el-alert
        v-if="targetNodes.length === 0"
        type="warning"
        :closable="false"
        :title="translate('generated.skillCenterPage.noManageableNodesAreAvailableForSkill')"
      />
      <el-alert
        v-else-if="targetNodeId && !targetReady"
        type="warning"
        :closable="false"
        :title="translate('generated.skillCenterPage.theCurrentNodeDoesNotSupportThis')"
      />

      <el-tabs v-model="activeConfigTab" class="skill-config-tabs">
        <el-tab-pane
          :label="translate('generated.skillCenterPage.availableSkills')"
          name="available"
        >
          <div class="skill-filter-bar">
            <el-input
              v-model="skillQuery"
              clearable
              :placeholder="translate('generated.skillCenterPage.searchSkillNamesOrDescriptions2')"
              :clear-icon="marIcon('clear-input')"
            />
            <div
              class="skill-category-strip"
              :aria-label="translate('generated.skillCenterPage.skillCategories2')"
            >
              <button :class="{ selected: selectedCategory === '' }" @click="selectedCategory = ''">
                {{ translate('generated.skillCenterPage.all2') }}
              </button>
              <button
                v-for="tag in availableTags"
                :key="tag"
                :class="{ selected: selectedCategory === tag }"
                @click="selectedCategory = tag"
              >
                {{ tag }}
              </button>
            </div>
          </div>
          <div
            v-loading="
              catalogReady
                ? availablePagination.loading.value && !availablePagination.loadingMore.value
                : service.loading.value
            "
            :element-loading-custom-class="catalogReady ? undefined : 'mar-page-loading'"
            class="skill-table-section"
          >
            <template v-if="filteredFavorites.length > 0">
              <el-table
                class="clickable-rows available-skill-table"
                :data="displayedFavorites"
                row-key="id"
                @row-click="showFavoriteDetails"
                @sort-change="availablePagination.sort"
              >
                <el-table-column
                  prop="normalizedName"
                  :label="translate('generated.skillSourceManagementPage.name')"
                  sortable="custom"
                  min-width="180"
                />
                <el-table-column
                  :label="translate('generated.skillDetailsDialog.availability')"
                  width="140"
                  class-name="skill-scope-column"
                >
                  <template #default="{ row }">{{ scopeLabel(row.scope) }}</template>
                </el-table-column>
                <el-table-column
                  prop="description"
                  :label="translate('conversationTemplates.description')"
                  min-width="280"
                  show-overflow-tooltip
                >
                  <template #default="{ row }">
                    {{
                      row.description ||
                      translate('generated.skillCenterPage.noDescriptionIsAvailableForThisSkill2')
                    }}
                  </template>
                </el-table-column>
                <el-table-column
                  :label="translate('generated.skillDetailsDialog.tags')"
                  min-width="150"
                >
                  <template #default="{ row }">
                    <div v-if="row.featured || row.tags.length > 0" class="skill-tags">
                      <el-tag v-if="row.featured" type="warning" effect="plain"
                        >★ {{ translate('generated.skillCenterPage.featured2') }}</el-tag
                      >
                      <el-tag v-for="tag in row.tags" :key="tag" type="info" effect="plain">{{
                        tag
                      }}</el-tag>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column
                  :label="translate('generated.skillSourceManagementPage.actions')"
                  min-width="220"
                >
                  <template #default="{ row }">
                    <div class="row-actions" @click.stop>
                      <el-button
                        link
                        :icon="marIcon('download')"
                        :disabled="!targetReady || targetMutationPending"
                        @click="install(row)"
                        >{{ installLabel(row) }}</el-button
                      >
                      <div
                        v-if="installingFavoriteId === row.id && showInstallProgress"
                        class="skill-install-progress"
                      >
                        <span>{{
                          translate(
                            'generated.skillCenterPage.installingAndValidatingTheSkillOnThe'
                          )
                        }}</span>
                        <div
                          class="skill-install-progress__indicator"
                          role="progressbar"
                          :aria-label="
                            translate(
                              'generated.skillCenterPage.installingAndValidatingTheSkillOnThe'
                            )
                          "
                        />
                      </div>
                    </div>
                  </template>
                </el-table-column>
              </el-table>
              <ManagementPagination
                :total="availablePagination.total.value"
                :has-more="availablePagination.hasMore.value"
                :page="availablePagination.page.value"
                :mobile="availablePagination.mobileViewport.value"
                :mobile-visible-count="availablePagination.mobileVisibleCount.value"
                :loading="availablePagination.loading.value"
                :loading-more="availablePagination.loadingMore.value"
                @page="availablePagination.setPage"
                :failed="availablePagination.failure.value !== undefined"
                :error="availablePagination.failure.value?.error"
                :context-key="availablePagination.contextKey.value"
                @retry="availablePagination.retry"
                @load-more="availablePagination.loadMore"
              />
            </template>
            <div v-else-if="!service.loading.value" class="skill-empty">
              {{
                service.favorites.value.length === 0
                  ? translate('generated.skillCenterPage.noSkillsAreAvailableAddSkillsFrom2')
                  : translate('generated.skillCenterPage.noMatchingSkills2')
              }}
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane
          :label="translate('generated.skillCenterPage.installedSkills')"
          name="installed"
        >
          <div v-loading="service.targetLoading.value" class="skill-table-section">
            <template v-if="(service.target.value?.skills.length ?? 0) > 0">
              <el-table
                class="clickable-rows installed-skill-table"
                :data="displayedInstalledSkills"
                row-key="name"
                @row-click="showInstalledDetails"
              >
                <el-table-column
                  prop="name"
                  :label="translate('generated.skillSourceManagementPage.name')"
                  sortable
                  min-width="180"
                />
                <el-table-column
                  :label="translate('generated.skillDetailsDialog.status')"
                  min-width="160"
                >
                  <template #default="{ row }">
                    <el-tag
                      :type="row.localStatus === 'VALID' ? 'success' : 'warning'"
                      effect="plain"
                    >
                      {{ statusLabel(row) }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column
                  prop="description"
                  :label="translate('conversationTemplates.description')"
                  min-width="280"
                  show-overflow-tooltip
                >
                  <template #default="{ row }">
                    {{
                      row.description ||
                      translate('generated.skillCenterPage.noValidSkillDescriptionWasFound')
                    }}
                  </template>
                </el-table-column>
                <el-table-column
                  :label="translate('generated.skillDetailsDialog.version')"
                  width="120"
                >
                  <template #default="{ row }">{{
                    row.install?.commitSha.slice(0, 8) ?? '—'
                  }}</template>
                </el-table-column>
                <el-table-column
                  :label="translate('generated.skillSourceManagementPage.actions')"
                  min-width="300"
                >
                  <template #default="{ row }">
                    <div class="row-actions" @click.stop>
                      <el-button
                        v-if="matchingFavorite(row)"
                        link
                        :icon="marIcon('retry')"
                        :disabled="!targetReady || targetMutationPending"
                        @click="install(matchingFavorite(row)!)"
                        >{{
                          matchingFavorite(row)?.commitSha !== row.install?.commitSha
                            ? translate('generated.skillCenterPage.update2')
                            : translate('generated.skillCenterPage.reinstall2')
                        }}</el-button
                      >
                      <el-button
                        link
                        type="danger"
                        :icon="marIcon('delete')"
                        :disabled="!targetReady || targetMutationPending"
                        @click="removeInstalled(row.name)"
                        >{{ translate('generated.skillCenterPage.delete') }}</el-button
                      >
                      <div
                        v-if="
                          matchingFavorite(row)?.id === installingFavoriteId && showInstallProgress
                        "
                        class="skill-install-progress"
                      >
                        <span>{{
                          translate(
                            'generated.skillCenterPage.installingAndValidatingTheSkillOnThe2'
                          )
                        }}</span>
                        <div
                          class="skill-install-progress__indicator"
                          role="progressbar"
                          :aria-label="
                            translate(
                              'generated.skillCenterPage.installingAndValidatingTheSkillOnThe2'
                            )
                          "
                        />
                      </div>
                    </div>
                  </template>
                </el-table-column>
              </el-table>
            </template>
            <el-empty
              v-else-if="service.target.value"
              :description="translate('generated.skillCenterPage.thisTargetHasNoInstalledSkills')"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
    </section>
    <SkillDetailsDialog v-model="detailsOpen" :details="skillDetails" />
  </section>
</template>

<style scoped>
.skill-page {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  background: var(--mar-bg-panel);
  padding: 14px 16px;
}
.skill-page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.skill-page-header p {
  margin: 2px 0 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-body);
}
.skill-content {
  display: flex;
  min-height: 0;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding-right: 4px;
}
.skill-config-tabs {
  min-height: 260px;
}
.skill-config-tabs :deep(.el-tab-pane) {
  display: grid;
  gap: 14px;
}
.skill-filter-bar {
  display: grid;
  gap: 10px;
}
.skill-filter-bar > :deep(.el-input) {
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
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.skill-category-strip button.selected {
  border-color: var(--mar-border-medium);
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
  font-weight: 400;
}
.skill-category-strip button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.skill-install-progress {
  display: grid;
  gap: 5px;
  min-width: 180px;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}
.skill-install-progress__indicator {
  position: relative;
  overflow: hidden;
  block-size: 4px;
  border-radius: 2px;
  background: var(--el-fill-color-light);
}
.skill-install-progress__indicator::after {
  position: absolute;
  inset: 0 auto 0 0;
  width: 40%;
  background: var(--el-color-primary);
  content: '';
  animation: skill-install-progress 1.4s ease-in-out infinite;
}
@keyframes skill-install-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .skill-install-progress__indicator::after {
    width: 100%;
    opacity: 0.6;
    animation: none;
    transform: none;
  }
}
.skill-table-section {
  min-height: 180px;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.available-skill-table :deep(.skill-scope-column .cell) {
  white-space: nowrap;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
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
.target-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--mar-fill-hover);
  padding-bottom: 12px;
}
.target-panel > div:first-child {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 2px;
}
.target-panel strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
}
.target-panel div span,
.target-name {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}
.target-select {
  width: min(240px, 100%);
}
.target-option-state {
  float: right;
  margin-left: 16px;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
.installed-heading {
  margin: 4px 0 0;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 600;
}
@media (max-width: 700px) {
  .skill-page {
    overflow-x: hidden;
    overflow-y: auto;
    padding: 12px;
  }
  .skill-content,
  .skill-page > :deep(.mcp-panel) {
    flex: none;
    overflow: visible;
    padding-right: 0;
  }
  .skill-filter-bar {
    grid-template-columns: 1fr;
  }
  .target-panel :deep(.el-button) {
    min-height: 36px;
  }
}
</style>
