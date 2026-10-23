<script setup lang="ts">
import { showMessage } from '../../service/MessageFeedbackService.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { managementDateTime } from '../../util/time-presentation.js';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules, TagProps } from 'element-plus';
import {
  XAI_SUBSCRIPTION_BASE_URL,
  resolveMarAgentDefaultReasoningEffort
} from '@myagentroam/protocol';
import type {
  CodexCredentialDetails,
  CodexCredentialOwnership,
  CodexCredentialSummary,
  CodexCredentialUsage,
  CodexLoginAttempt,
  CodexModelCatalog,
  CodexModelImportResult,
  MarAgentModelSummary,
  MarAgentModelTransportTestResult,
  MarAgentResponsesTransport,
  ResourceOwnership
} from '@myagentroam/protocol';
import type { NodeSummary } from '../../model/workbench';
import {
  CodexLoginAttemptPoller,
  buildCodexModelImportRequest,
  codexCredentialErrorMessageKey,
  credentialRefreshOutcome,
  createCodexCredentialManagementService,
  eligibleMarAgentTransportTestNodes,
  modelProtocolChoice,
  modelSupportsNodeTransport,
  type CodexImportDraft
} from '../../service/CodexCredentialManagementService';
import { translate } from '../../service/LocalePreferenceService';
import { createManagementOrderState } from '../../service/ManagementOrderState';
import { runnerUsageWindowLabel } from '../../service/RunnerUsageService';
import { errorCode } from '../../util/api-error';
import { codexUsageTokenCountLabel, errorMessage } from '../../util/workbench-presentation';
import ImageGenerationManagement from './ImageGenerationManagement.vue';
import MarAgentCompactSettings from './MarAgentCompactSettings.vue';
import PromptCompletionSettings from './PromptCompletionSettings.vue';
import ChatGPTManageUsageButton from '../common/ChatGPTManageUsageButton.vue';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
type ModelSummary = Omit<MarAgentModelSummary, 'reasoningEfforts' | 'defaultReasoningEffort'> & {
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
};
type ProtocolChoice = ReturnType<typeof modelProtocolChoice>;
type TransportChoice = 'WEBSOCKET' | 'HTTP_2' | 'HTTP_1_1';
type ActiveTab = 'modelOrder' | 'models' | 'codexCredentials' | 'imageGeneration' | 'compact';
type CredentialAction = 'EDIT' | 'TEST' | 'REMOVE' | 'REFRESH';

interface ModelDraft {
  id: string;
  name: string;
  protocol: ProtocolChoice;
  baseUrl: string;
  credentialId: string;
  apiKey: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  inputCapabilities: ('TEXT' | 'IMAGE')[];
  outputCapabilities: ['TEXT'];
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  conversationModel: boolean;
  titleGeneration: boolean;
  codeMode: boolean;
  serviceTier: NonNullable<MarAgentModelSummary['serviceTier']>;
  hostedWebSearch: boolean;
  responsesTransport: MarAgentResponsesTransport | undefined;
  responsesPreviousResponseId: boolean;
  enabled: boolean;
  sortOrder: number;
}

interface CredentialLoginDraft {
  type: 'CODEX_OAUTH' | 'CHATGPT_OAUTH' | 'XAI_OAUTH';
  nodeId: string;
  name: string;
  socks5Url: string;
  targetCredentialId?: string;
}

type MutableCodexImportDraft = {
  -readonly [Key in keyof CodexImportDraft]: CodexImportDraft[Key];
};

interface CatalogRow extends MutableCodexImportDraft {
  readonly displayName: string;
  readonly description?: string;
  readonly warnings: readonly string[];
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly defaultReasoningEffort: ReasoningEffort;
  readonly unsupportedReasoningEfforts: readonly string[];
  readonly requiredInputs: readonly 'contextWindowTokens'[];
}

const reasoningEffortOptions: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
];
const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const props = defineProps<{
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly writable: boolean;
  readonly nodes: readonly NodeSummary[];
  readonly canManageModels?: boolean;
  readonly canManageCompact?: boolean;
  readonly compactPreferredOrganizationId?: number | undefined;
  readonly modelContext?: Readonly<Record<string, unknown>>;
  readonly modelOwnershipRules?: FormRules;
  readonly prepareModel?: (model?: ModelSummary) => Promise<void>;
  readonly modelOwnership?: () => ResourceOwnership | undefined;
  readonly catalogContext?: Readonly<Record<string, unknown>>;
  readonly catalogOwnershipRules?: FormRules;
  readonly prepareCatalog?: (credential: CodexCredentialSummary) => Promise<void>;
  readonly catalogOwnership?: () => ResourceOwnership | undefined;
  readonly credentialContext?: Readonly<Record<string, unknown>>;
  readonly credentialOwnershipRules?: FormRules;
  readonly prepareCredential?: (credential?: CodexCredentialSummary) => Promise<void>;
  readonly credentialOwnership?: () =>
    CodexCredentialOwnership | { readonly ownerType: 'PERSONAL' };
  readonly credentialScopeLabel?: (ownership: CodexCredentialOwnership) => string;
}>();
const credentialService = createCodexCredentialManagementService(props.request);
const canManageModels = computed(() => props.canManageModels !== false);
const credentialOwnershipValue = ref<CodexCredentialOwnership | { readonly ownerType: 'PERSONAL' }>(
  { ownerType: 'PERSONAL' }
);
const activeTab = ref<ActiveTab>(canManageModels.value ? 'models' : 'modelOrder');
// Model, personal-order, and OAuth credential tabs render the server response as-is.
// Those reads already return the full authorized set with no page or limit, and the
// expected volume is small, so the shared 20-item management page would only hide rows.
// Image generation and Compact are not these list tabs. Other management lists keep paging.
const models = ref<ModelSummary[]>([]);
const personalModels = ref<ModelSummary[]>([]);
const credentials = ref<readonly CodexCredentialSummary[]>([]);
const loading = ref(false);
const personalOrderLoading = ref(false);
const credentialLoading = ref(false);
const credentialsLoaded = ref(false);
const modelsReady = ref(false);
const personalOrderReady = ref(false);
const initialLoading = computed(() =>
  activeTab.value === 'models'
    ? loading.value && !modelsReady.value
    : activeTab.value === 'modelOrder'
      ? personalOrderLoading.value && !personalOrderReady.value
      : activeTab.value === 'codexCredentials'
        ? credentialLoading.value && !credentialsLoaded.value
        : false
);
const saving = ref(false);
const savingOrder = ref(false);
const savingPersonalOrder = ref(false);
const {
  sorting,
  draggedId: draggedModelId,
  startSorting,
  cancelSorting,
  finishSorting,
  dragStart,
  dragOver
} = createManagementOrderState(
  models,
  () => props.writable && !savingOrder.value && !loading.value
);
const {
  sorting: personalSorting,
  draggedId: draggedPersonalModelId,
  startSorting: startPersonalSorting,
  cancelSorting: cancelPersonalSorting,
  finishSorting: finishPersonalSorting,
  dragStart: personalDragStart,
  dragOver: personalDragOver
} = createManagementOrderState(
  personalModels,
  () => props.writable && !savingPersonalOrder.value && !personalOrderLoading.value
);
const testingIds = ref(new Set<string>());
const dialog = ref(false);
const editingId = ref<string>();
const duplicatingId = ref<string>();
const savedCredentialProtocol = ref<ProtocolChoice>();
const editingCredentialType = ref<ModelSummary['credentialType']>();
const canKeepCredential = computed(() =>
  editingCredentialType.value === 'INLINE_API_KEY'
    ? !isOAuthProtocol(draft.protocol)
    : editingCredentialType.value === 'CREDENTIAL_REF' &&
      draft.protocol === savedCredentialProtocol.value
);
const formRef = ref<FormInstance>();
const draft = reactive<ModelDraft>(emptyDraft());
const modelFormModel = computed(() => ({ ...draft, ...props.modelContext }));
const selectedModelDetail = ref<ModelSummary>();
const credentialDialog = ref(false);
const credentialFormRef = ref<FormInstance>();
const credentialSaving = ref(false);
let credentialLoginStarting = false;
const credentialDraft = reactive<CredentialLoginDraft>(emptyCredentialDraft());
const eligibleLoginNodes = computed(() =>
  props.nodes.filter(
    (node) =>
      node.connected &&
      !node.disabled &&
      node.capabilities.chatgptLogin?.apiVersion === 1 &&
      node.capabilities.chatgptLogin.loopback
  )
);
function isOAuthProtocol(protocol: ProtocolChoice): boolean {
  return protocol === 'CODEX' || protocol === 'CHATGPT' || protocol === 'GROK';
}
function oauthBaseUrl(protocol: ProtocolChoice): string {
  if (protocol === 'CODEX') return 'https://chatgpt.com/backend-api/codex';
  return protocol === 'GROK' ? XAI_SUBSCRIPTION_BASE_URL : 'https://api.openai.com/v1';
}
function oauthCredentialType(protocol: ProtocolChoice): CodexCredentialSummary['type'] {
  if (protocol === 'CHATGPT') return 'CHATGPT_OAUTH';
  return protocol === 'GROK' ? 'XAI_OAUTH' : 'CODEX_OAUTH';
}
function grokTransport(): MarAgentResponsesTransport {
  return { transport: 'HTTP', httpVersion: '1.1' };
}
const availableModelCredentials = computed(() =>
  credentials.value.filter(
    (credential) =>
      credential.type === oauthCredentialType(draft.protocol) &&
      credential.authorization !== 'UNAUTHORIZED'
  )
);
const credentialEditId = ref<string>();
let credentialEditSequence = 0;
const loginAttemptDialog = ref(false);
const loginAttempt = ref<CodexLoginAttempt>();
const loginAttemptRefreshing = ref(false);
const countdownNow = ref(Date.now());
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const credentialActions = ref(new Map<string, CredentialAction>());
const selectedCredentialDetails = ref<CodexCredentialDetails>();
const selectedCredentialUsage = ref<CodexCredentialUsage>();
const credentialDetailOpen = ref(false);
const credentialDetailLoading = ref(false);
const credentialUsageLoading = ref(false);
let credentialDetailSequence = 0;
const catalogDialog = ref(false);
const catalogLoading = ref(false);
const catalogImporting = ref(false);
const catalogFormRef = ref<FormInstance>();
const catalogCredential = ref<CodexCredentialSummary>();
const catalog = ref<CodexModelCatalog>();
const catalogRows = ref<CatalogRow[]>([]);
let catalogSequence = 0;
const importResult = ref<CodexModelImportResult>();
const importResultDialog = computed({
  get: () => importResult.value !== undefined,
  set: (value) => {
    if (!value) importResult.value = undefined;
  }
});
const modelTestDialog = ref(false);
const modelTestModel = ref<ModelSummary>();
const modelTestNodeId = ref('');
const modelTestResult = ref<MarAgentModelTransportTestResult>();
let modelTestSequence = 0;

const loginPoller = new CodexLoginAttemptPoller(credentialService, {
  onChange: (attempt) => {
    loginAttempt.value = attempt;
    if (attempt.status === 'PENDING') startCountdown();
    else stopCountdown();
  },
  onTerminal: (attempt) => {
    if (attempt.status === 'SUCCEEDED') {
      showMessage(translate('marAgentModels.codexLoginSucceeded'), 'success');
      void loadCredentials(false);
    } else if (attempt.status !== 'CANCELLED') {
      showCodexError(attempt.code, attempt.message, 'marAgentModels.codexLoginFailed');
    }
  },
  onError: (error) => showCodexRequestError(error, 'marAgentModels.codexLoginFailed')
});

const modelDetailOpen = computed({
  get: () => selectedModelDetail.value !== undefined,
  set: (value) => {
    if (!value) selectedModelDetail.value = undefined;
  }
});
const responsesTransportChoice = computed<TransportChoice>({
  get: () => {
    const transport = draft.responsesTransport;
    if (transport?.transport === 'WEBSOCKET') return 'WEBSOCKET';
    return transport?.httpVersion === '2' ? 'HTTP_2' : 'HTTP_1_1';
  },
  set: (value) => {
    draft.responsesTransport = transportFromChoice(value);
  }
});
const loginAttemptSeconds = computed(() => {
  const attempt = loginAttempt.value;
  return attempt?.status === 'PENDING' && attempt.expiresAt !== undefined
    ? Math.max(0, Math.ceil((attempt.expiresAt - countdownNow.value) / 1000))
    : 0;
});
const eligibleTestNodes = computed(() => {
  const model = modelTestModel.value;
  if (model === undefined) return [];
  return eligibleMarAgentTransportTestNodes(props.nodes).filter((node) =>
    modelSupportsNodeTransport(
      node,
      model.responsesTransport,
      model.serviceTier,
      modelProtocolChoice(model) === 'GROK',
      model.responsesPreviousResponseId === true
    )
  );
});
const selectedCatalogCount = computed(() => catalogRows.value.filter((row) => row.selected).length);
const defaultReasoningEffortOptions = computed<readonly ReasoningEffort[]>(() =>
  draft.reasoningEfforts.length > 0 ? draft.reasoningEfforts : reasoningEffortOptions
);
const rules = computed<FormRules>(() => ({
  name: [{ required: true, whitespace: true, message: translate('marAgentModels.nameRequired') }],
  protocol: [{ required: true, message: translate('marAgentModels.protocolRequired') }],
  baseUrl: [
    { required: true, message: translate('marAgentModels.urlRequired') },
    {
      validator: (_rule, value, callback) => {
        if (isOAuthProtocol(draft.protocol)) return callback();
        try {
          new URL(String(value));
          callback();
        } catch {
          callback(new Error(translate('marAgentModels.urlInvalid')));
        }
      }
    }
  ],
  apiKey: [
    {
      validator: (_rule, value, callback) => {
        if (isOAuthProtocol(draft.protocol)) return callback();
        if (String(value ?? '').trim() || canKeepCredential.value) return callback();
        callback(new Error(translate('marAgentModels.keyRequired')));
      }
    }
  ],
  credentialId: [
    {
      validator: (_rule, value, callback) => {
        if (!isOAuthProtocol(draft.protocol)) return callback();
        if (String(value ?? '').trim() || canKeepCredential.value) return callback();
        callback(new Error(translate('marAgentModels.credentialRequired')));
      }
    }
  ],
  modelId: [
    { required: true, whitespace: true, message: translate('marAgentModels.modelRequired') }
  ],
  maxOutputTokens: [
    {
      validator: (_rule, value, callback) =>
        Number(value) < draft.contextWindowTokens
          ? callback()
          : callback(new Error(translate('marAgentModels.outputLessThanContext')))
    }
  ],
  defaultReasoningEffort: [
    {
      required: true,
      message: translate('marAgentModels.defaultReasoningEffortRequired'),
      trigger: 'change'
    },
    {
      validator: (_rule, value, callback) =>
        draft.reasoningEfforts.length === 0 ||
        draft.reasoningEfforts.includes(value as ReasoningEffort)
          ? callback()
          : callback(new Error(translate('marAgentModels.defaultReasoningEffortUnsupported'))),
      trigger: 'change'
    }
  ]
}));
const credentialRules = computed<FormRules>(() => ({
  name: [
    {
      required: true,
      whitespace: true,
      message: translate('marAgentModels.credentialNameRequired')
    }
  ],
  nodeId: [
    {
      validator: (_rule, value, callback) => {
        if (
          credentialEditId.value !== undefined ||
          credentialDraft.type !== 'CHATGPT_OAUTH' ||
          eligibleLoginNodes.value.some((node) => node.id === value)
        )
          return callback();
        callback(new Error(translate('marAgentModels.chatgptLocalNodeRequired')));
      },
      trigger: 'change'
    }
  ],
  socks5Url: [
    {
      validator: (_rule, value, callback) => {
        if (!String(value ?? '').trim()) return callback();
        try {
          const url = new URL(String(value));
          if (url.protocol !== 'socks5:') throw new Error();
          callback();
        } catch {
          callback(new Error(translate('marAgentModels.codexProxyInvalid')));
        }
      }
    }
  ]
}));
watch(activeTab, (tab) => {
  if (tab === 'codexCredentials') {
    void loadCredentials();
  } else if (tab === 'modelOrder') {
    void loadPersonalModels();
  }
});
watch(canManageModels, (allowed) => {
  if (!allowed) activeTab.value = 'modelOrder';
});
watch(credentialDialog, (open) => {
  if (!open) resetCredentialDialog();
});
watch(credentialDetailOpen, (open) => {
  if (!open) resetCredentialDetails();
});
watch(catalogDialog, (open) => {
  if (!open) resetCatalogDialog();
});
watch(modelTestDialog, (open) => {
  if (!open) {
    modelTestSequence += 1;
    modelTestResult.value = undefined;
    modelTestModel.value = undefined;
    modelTestNodeId.value = '';
  }
});
watch(modelTestNodeId, () => {
  modelTestSequence += 1;
  modelTestResult.value = undefined;
});
watch(eligibleTestNodes, (nodes) => {
  if (!nodes.some((node) => node.id === modelTestNodeId.value)) modelTestNodeId.value = '';
});
watch(
  () => [...draft.reasoningEfforts],
  (efforts) => {
    draft.defaultReasoningEffort = resolveMarAgentDefaultReasoningEffort(
      draft.defaultReasoningEffort,
      efforts
    );
  }
);

function emptyDraft(): ModelDraft {
  return {
    id: '',
    name: '',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://api.anthropic.com',
    credentialId: '',
    apiKey: '',
    modelId: '',
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    conversationModel: true,
    titleGeneration: false,
    codeMode: false,
    serviceTier: 'default',
    hostedWebSearch: false,
    responsesTransport: undefined,
    responsesPreviousResponseId: false,
    enabled: true,
    sortOrder: 0
  };
}

function emptyCredentialDraft(): CredentialLoginDraft {
  return { name: '', socks5Url: '', type: 'CODEX_OAUTH', nodeId: '' };
}

async function load(showLoading = true) {
  if (!canManageModels.value) {
    activeTab.value = 'codexCredentials';
    await loadCredentials(showLoading);
    return;
  }
  if (showLoading) loading.value = true;
  try {
    models.value = (
      await props.request<{ models: ModelSummary[] }>('/api/admin/mar-agent/models', {
        cache: 'no-store'
      })
    ).models.map((model) => ({
      ...model,
      defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
        model.defaultReasoningEffort,
        model.reasoningEfforts
      )
    }));
    modelsReady.value = true;
  } catch (error) {
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('marAgentModels.loadFailed'),
      'error',
      error
    );
  } finally {
    if (showLoading) loading.value = false;
  }
}

async function loadPersonalModels(showLoading = true) {
  if (showLoading) personalOrderLoading.value = true;
  try {
    personalModels.value = (
      await props.request<{ models: ModelSummary[] }>('/api/mar-agent/models', {
        cache: 'no-store'
      })
    ).models.map((model) => ({
      ...model,
      defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
        model.defaultReasoningEffort,
        model.reasoningEfforts
      )
    }));
    personalOrderReady.value = true;
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('marAgentModels.personalOrderLoadFailed'),
      'error',
      error
    );
  } finally {
    if (showLoading) personalOrderLoading.value = false;
  }
}

async function loadCredentials(showLoading = true): Promise<void> {
  if (showLoading) credentialLoading.value = true;
  try {
    credentials.value = await credentialService.listCredentials();
    credentialsLoaded.value = true;
  } catch (error) {
    showCodexRequestError(error, 'marAgentModels.codexLoadFailed');
  } finally {
    if (showLoading) credentialLoading.value = false;
  }
}

async function ensureCredentials(): Promise<void> {
  if (!credentialsLoaded.value) await loadCredentials(false);
}

async function openCreate() {
  try {
    await props.prepareModel?.();
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
    return;
  }
  await ensureCredentials();
  Object.assign(draft, emptyDraft());
  draft.sortOrder = Math.max(-1, ...models.value.map((model) => model.sortOrder)) + 1;
  editingId.value = undefined;
  duplicatingId.value = undefined;
  savedCredentialProtocol.value = undefined;
  editingCredentialType.value = undefined;
  dialog.value = true;
}

function changeProtocol(protocol: ProtocolChoice): void {
  const previous = draft.protocol;
  draft.protocol = protocol;
  const oauth = isOAuthProtocol(protocol);
  if (
    !oauth &&
    [
      'https://api.anthropic.com',
      oauthBaseUrl('OPENAI_RESPONSES'),
      oauthBaseUrl('CODEX'),
      oauthBaseUrl('GROK'),
      ''
    ].includes(draft.baseUrl)
  ) {
    draft.baseUrl =
      protocol === 'ANTHROPIC_MESSAGES' ? 'https://api.anthropic.com' : oauthBaseUrl(protocol);
  }
  if (
    oauth &&
    draft.credentialId &&
    !availableModelCredentials.value.some((credential) => credential.id === draft.credentialId)
  )
    draft.credentialId = '';
  if (!oauth || protocol === 'GROK') draft.serviceTier = 'default';
  if (protocol === 'ANTHROPIC_MESSAGES') {
    draft.hostedWebSearch = false;
    draft.responsesTransport = undefined;
    draft.responsesPreviousResponseId = false;
  } else {
    if (previous === 'ANTHROPIC_MESSAGES') {
      draft.responsesPreviousResponseId = oauth && protocol !== 'GROK';
      draft.hostedWebSearch = protocol === 'GROK';
    }
    if (
      protocol === 'GROK' &&
      draft.responsesTransport?.transport === 'HTTP' &&
      draft.responsesTransport.httpVersion === '2'
    )
      draft.responsesTransport = grokTransport();
    draft.responsesTransport ??=
      protocol === 'GROK' ? grokTransport() : oauth ? { transport: 'WEBSOCKET' } : undefined;
  }
  formRef.value?.clearValidate();
  if (oauth) void ensureCredentials();
}

async function saveOrder() {
  savingOrder.value = true;
  try {
    await props.request('/api/admin/mar-agent/models/order', {
      method: 'PUT',
      body: JSON.stringify({ modelIds: models.value.map((model) => model.id) })
    });
    finishSorting();
    showMessage(translate('marAgentModels.orderSaved'), 'success');
    await load(false);
  } catch (error) {
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('marAgentModels.orderSaveFailed'),
      'error',
      error
    );
  } finally {
    savingOrder.value = false;
  }
}

async function savePersonalOrder() {
  savingPersonalOrder.value = true;
  try {
    await props.request('/api/mar-agent/models/order', {
      method: 'PUT',
      body: JSON.stringify({ modelIds: personalModels.value.map((model) => model.id) })
    });
    finishPersonalSorting();
    showMessage(translate('marAgentModels.personalOrderSaved'), 'success');
    await loadPersonalModels(false);
  } catch (error) {
    showMessage(
      error instanceof Error
        ? errorMessage(error)
        : translate('marAgentModels.personalOrderSaveFailed'),
      'error',
      error
    );
  } finally {
    savingPersonalOrder.value = false;
  }
}

async function openEdit(model: ModelSummary, duplicate = false) {
  try {
    await props.prepareModel?.(duplicate ? undefined : model);
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
    return;
  }
  await ensureCredentials();
  const credentialType = model.credentialType ?? 'INLINE_API_KEY';
  const protocol = modelProtocolChoice(model);
  Object.assign(draft, {
    id: model.id,
    name: model.name,
    protocol: modelProtocolChoice(model),
    baseUrl: model.baseUrl,
    credentialId: '',
    apiKey: '',
    modelId: model.modelId,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    inputCapabilities: [...model.inputCapabilities],
    outputCapabilities: [...model.outputCapabilities],
    reasoningEfforts: [...model.reasoningEfforts],
    defaultReasoningEffort: model.defaultReasoningEffort,
    conversationModel: model.conversationModel ?? true,
    titleGeneration: model.titleGeneration,
    codeMode: model.codeMode,
    serviceTier: model.serviceTier ?? (model.fastMode === true ? 'priority' : 'default'),
    hostedWebSearch: model.hostedWebSearch,
    responsesTransport:
      protocol === 'GROK'
        ? (model.responsesTransport ?? grokTransport())
        : credentialType === 'CREDENTIAL_REF'
          ? (model.responsesTransport ?? { transport: 'WEBSOCKET' })
          : model.responsesTransport,
    responsesPreviousResponseId: model.responsesPreviousResponseId ?? false,
    enabled: model.enabled,
    sortOrder: model.sortOrder
  });
  editingId.value = duplicate ? undefined : model.id;
  duplicatingId.value = duplicate ? model.id : undefined;
  savedCredentialProtocol.value = protocol;
  editingCredentialType.value = credentialType;
  if (duplicate) {
    draft.id = '';
    draft.name = translate('marAgentModels.copyName', { name: model.name });
    draft.sortOrder = Math.max(-1, ...models.value.map((value) => value.sortOrder)) + 1;
  }
  dialog.value = true;
}

async function save() {
  if (!(await formRef.value?.validate().catch(() => false))) return;
  saving.value = true;
  try {
    const path = duplicatingId.value
      ? `/api/admin/mar-agent/models/${duplicatingId.value}/duplicate`
      : editingId.value
        ? `/api/admin/mar-agent/models/${editingId.value}`
        : '/api/admin/mar-agent/models';
    await props.request(path, {
      method: editingId.value ? 'PUT' : 'POST',
      body: JSON.stringify(modelSaveBody())
    });
    dialog.value = false;
    showMessage(
      translate(duplicatingId.value ? 'marAgentModels.duplicated' : 'marAgentModels.saved'),
      'success'
    );
    await load(false);
  } catch (error) {
    showMessage(
      error instanceof Error ? errorMessage(error) : translate('marAgentModels.loadFailed'),
      'error',
      error
    );
  } finally {
    saving.value = false;
  }
}

function modelSaveBody(): Record<string, unknown> {
  const oauth = isOAuthProtocol(draft.protocol);
  const grok = draft.protocol === 'GROK';
  const body: Record<string, unknown> = {
    name: draft.name.trim(),
    protocol: oauth ? 'OPENAI_RESPONSES' : draft.protocol,
    baseUrl: oauth ? oauthBaseUrl(draft.protocol) : draft.baseUrl.trim(),
    modelId: draft.modelId.trim(),
    contextWindowTokens: draft.contextWindowTokens,
    maxOutputTokens: draft.maxOutputTokens,
    inputCapabilities: draft.inputCapabilities,
    outputCapabilities: draft.outputCapabilities,
    reasoningEfforts: draft.reasoningEfforts,
    defaultReasoningEffort: draft.defaultReasoningEffort,
    conversationModel: draft.conversationModel,
    titleGeneration: draft.titleGeneration,
    codeMode: draft.codeMode,
    ...(oauth && !grok ? { serviceTier: draft.serviceTier } : {}),
    hostedWebSearch: draft.hostedWebSearch,
    responsesPreviousResponseId:
      draft.protocol === 'ANTHROPIC_MESSAGES' ? false : draft.responsesPreviousResponseId,
    enabled: draft.enabled,
    sortOrder: draft.sortOrder,
    ...(draft.protocol !== 'ANTHROPIC_MESSAGES' && draft.responsesTransport !== undefined
      ? { responsesTransport: draft.responsesTransport }
      : {})
  };
  if (editingId.value === undefined) {
    const ownership = props.modelOwnership?.();
    if (ownership !== undefined) body.ownership = ownership;
  }
  if (oauth && draft.credentialId.trim())
    body.credential = { type: 'CREDENTIAL_REF', credentialId: draft.credentialId };
  else if (!oauth && draft.apiKey.trim())
    body.credential = { type: 'INLINE_API_KEY', value: draft.apiKey };
  return body;
}

async function remove(model: ModelSummary) {
  try {
    await ElMessageBox.confirm(
      translate('marAgentModels.confirmRemove', { name: model.name }),
      translate('marAgentModels.remove'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('marAgentModels.remove'),
        cancelButtonText: translate('marAgentModels.cancel')
      }
    );
    await props.request(`/api/admin/mar-agent/models/${model.id}`, { method: 'DELETE' });
    showMessage(translate('marAgentModels.removed'), 'success');
    await load(false);
  } catch (error) {
    if (error !== 'cancel')
      showMessage(
        error instanceof Error ? errorMessage(error) : translate('marAgentModels.removeFailed'),
        'error',
        error
      );
  }
}

function openModelTest(model: ModelSummary): void {
  modelTestSequence += 1;
  modelTestResult.value = undefined;
  modelTestModel.value = model;
  modelTestNodeId.value = '';
  if (
    !eligibleMarAgentTransportTestNodes(props.nodes).some((node) =>
      modelSupportsNodeTransport(
        node,
        model.responsesTransport,
        undefined,
        modelProtocolChoice(model) === 'GROK',
        model.responsesPreviousResponseId === true
      )
    )
  ) {
    showMessage(translate('marAgentModels.modelTestNoNode'), 'error');
    modelTestModel.value = undefined;
    return;
  }
  modelTestDialog.value = true;
}

async function test(model: ModelSummary) {
  if (!modelTestNodeId.value) return;
  const requestSequence = ++modelTestSequence;
  modelTestResult.value = undefined;
  testingIds.value = new Set(testingIds.value).add(model.id);
  try {
    const result = await credentialService.testModel(model.id, modelTestNodeId.value);
    if (requestSequence !== modelTestSequence) return;
    modelTestResult.value = result;
    await load(false);
  } catch (error) {
    if (requestSequence === modelTestSequence)
      showCodexRequestError(error, 'marAgentModels.testConnectionFailed');
  } finally {
    const next = new Set(testingIds.value);
    next.delete(model.id);
    testingIds.value = next;
  }
}

function openModelDetails(model: ModelSummary): void {
  if (sorting.value) return;
  selectedModelDetail.value = model;
}

async function openCredentialDetails(credential: CodexCredentialSummary): Promise<void> {
  const sequence = ++credentialDetailSequence;
  credentialDetailOpen.value = true;
  credentialDetailLoading.value = true;
  credentialUsageLoading.value = false;
  selectedCredentialDetails.value = undefined;
  selectedCredentialUsage.value = undefined;
  try {
    const details = await credentialService.credentialDetails(credential.id);
    if (sequence !== credentialDetailSequence || !credentialDetailOpen.value) return;
    selectedCredentialDetails.value = details;
  } catch (error) {
    if (sequence !== credentialDetailSequence) return;
    credentialDetailOpen.value = false;
    showCodexRequestError(error, 'marAgentModels.codexCredentialDetailsLoadFailed');
  } finally {
    if (sequence === credentialDetailSequence) credentialDetailLoading.value = false;
  }
}

async function loadCredentialUsage(credentialId: string): Promise<void> {
  const sequence = credentialDetailSequence;
  if (credentialUsageLoading.value) return;
  credentialUsageLoading.value = true;
  selectedCredentialUsage.value = undefined;
  try {
    const usage = await credentialService.credentialUsage(credentialId);
    if (
      sequence !== credentialDetailSequence ||
      !credentialDetailOpen.value ||
      selectedCredentialDetails.value?.credential.id !== credentialId
    )
      return;
    selectedCredentialUsage.value = usage;
  } catch (error) {
    if (sequence !== credentialDetailSequence || !credentialDetailOpen.value) return;
    showCodexRequestError(error, 'marAgentModels.codexUsageLoadFailed');
  } finally {
    if (sequence === credentialDetailSequence) credentialUsageLoading.value = false;
  }
}

function resetCredentialDetails(): void {
  credentialDetailSequence += 1;
  credentialDetailLoading.value = false;
  credentialUsageLoading.value = false;
  selectedCredentialDetails.value = undefined;
  selectedCredentialUsage.value = undefined;
}

async function openCredentialLogin(credential?: CodexCredentialSummary): Promise<void> {
  const sequence = ++credentialEditSequence;
  try {
    await props.prepareCredential?.(credential);
    const details = credential
      ? selectedCredentialDetails.value?.credential.id === credential.id
        ? selectedCredentialDetails.value
        : await credentialService.credentialDetails(credential.id)
      : undefined;
    if (sequence !== credentialEditSequence) return;
    credentialOwnershipValue.value = credential?.ownership ?? { ownerType: 'PERSONAL' };
    credentialDetailOpen.value = false;
    credentialEditId.value = undefined;
    Object.assign(credentialDraft, emptyCredentialDraft(), {
      name: credential?.name ?? '',
      type: credential?.type ?? 'CODEX_OAUTH',
      socks5Url: details?.socks5Url ?? '',
      targetCredentialId: credential?.id
    });
    credentialDialog.value = true;
  } catch (error) {
    if (sequence === credentialEditSequence)
      showCodexRequestError(error, 'marAgentModels.codexLoginFailed');
  }
}

async function openCredentialEdit(
  credential: CodexCredentialSummary,
  loadedDetails?: CodexCredentialDetails
): Promise<void> {
  if (!beginCredentialAction(credential.id, 'EDIT')) return;
  const sequence = ++credentialEditSequence;
  try {
    const details = loadedDetails ?? (await credentialService.credentialDetails(credential.id));
    if (sequence !== credentialEditSequence) return;
    await props.prepareCredential?.(details.credential);
    if (sequence !== credentialEditSequence) return;
    credentialOwnershipValue.value = details.credential.ownership;
    credentialEditId.value = credential.id;
    Object.assign(credentialDraft, {
      name: details.credential.name,
      type: details.credential.type,
      nodeId: '',
      socks5Url: details.socks5Url ?? '',
      targetCredentialId: undefined
    });
    credentialDetailOpen.value = false;
    credentialDialog.value = true;
  } catch (error) {
    if (sequence === credentialEditSequence)
      showCodexRequestError(error, 'marAgentModels.codexCredentialDetailsLoadFailed');
  } finally {
    finishCredentialAction(credential.id, 'EDIT');
  }
}

async function submitCredentialLogin(): Promise<void> {
  if (credentialSaving.value) return;
  if (!(await credentialFormRef.value?.validate().catch(() => false))) return;
  const sequence = credentialEditSequence;
  const editingCredentialId = credentialEditId.value;
  credentialSaving.value = true;
  try {
    if (editingCredentialId !== undefined) {
      await credentialService.updateCredential(editingCredentialId, {
        name: credentialDraft.name,
        ownership: props.credentialOwnership?.() ?? credentialOwnershipValue.value,
        socks5Url: credentialDraft.socks5Url.trim() || null
      });
      credentialDialog.value = false;
      showMessage(translate('marAgentModels.codexCredentialUpdated'), 'success');
      await loadCredentials(false);
      return;
    }
    credentialLoginStarting = true;
    const attempt = await loginPoller.begin({
      ...(credentialDraft.type === 'CHATGPT_OAUTH'
        ? { type: 'CHATGPT_OAUTH' as const, nodeId: credentialDraft.nodeId }
        : credentialDraft.type === 'XAI_OAUTH'
          ? { type: 'XAI_OAUTH' as const }
          : {}),
      name: credentialDraft.name,
      ownership: props.credentialOwnership?.() ?? credentialOwnershipValue.value,
      ...(credentialDraft.socks5Url.trim() ? { socks5Url: credentialDraft.socks5Url.trim() } : {}),
      ...(credentialDraft.targetCredentialId === undefined
        ? {}
        : { targetCredentialId: credentialDraft.targetCredentialId })
    });
    if (!attempt || sequence !== credentialEditSequence) return;
    credentialLoginStarting = false;
    loginAttempt.value = attempt;
    credentialDialog.value = false;
    loginAttemptDialog.value = true;
  } catch (error) {
    if (sequence !== credentialEditSequence) return;
    showCodexRequestError(
      error,
      editingCredentialId === undefined
        ? 'marAgentModels.codexLoginFailed'
        : 'marAgentModels.codexCredentialUpdateFailed'
    );
  } finally {
    credentialLoginStarting = false;
    credentialSaving.value = false;
  }
}

function resetCredentialDialog(): void {
  if (credentialLoginStarting) void loginPoller.cancel().catch(() => undefined);
  credentialEditSequence += 1;
  credentialEditId.value = undefined;
  Object.assign(credentialDraft, emptyCredentialDraft());
}

async function cancelLoginAttempt(): Promise<void> {
  try {
    await loginPoller.cancel();
    loginAttempt.value = undefined;
    loginAttemptDialog.value = false;
    stopCountdown();
  } catch (error) {
    showCodexRequestError(error, 'marAgentModels.codexLoginCancelFailed');
  }
}

async function refreshLoginAttempt(): Promise<void> {
  if (loginAttemptRefreshing.value || loginAttempt.value?.status !== 'PENDING') return;
  loginAttemptRefreshing.value = true;
  try {
    await loginPoller.refresh();
  } finally {
    loginAttemptRefreshing.value = false;
  }
}

async function refreshCredential(credential: CodexCredentialSummary): Promise<void> {
  await credentialAction(
    credential.id,
    'REFRESH',
    async () => {
      const refreshed = await credentialService.refreshCredential(credential.id);
      credentials.value = credentials.value.map((current) =>
        current.id === refreshed.id ? refreshed : current
      );
      if (selectedCredentialDetails.value?.credential.id === refreshed.id)
        selectedCredentialDetails.value = {
          ...selectedCredentialDetails.value,
          credential: refreshed
        };
      const outcome = credentialRefreshOutcome(credential, refreshed);
      if (outcome === 'DEFERRED')
        showMessage(
          translate('marAgentModels.chatgptRefreshDeferred', {
            time: formatTimestamp(refreshed.earliestRefreshAt)
          }),
          'info'
        );
      else if (outcome === 'DEGRADED')
        showMessage(translate('marAgentModels.codexRefreshDegraded'), 'warning');
      else if (outcome === 'UNCHANGED')
        showMessage(translate('marAgentModels.codexRefreshUnchanged'), 'info');
      else showMessage(translate('marAgentModels.codexRefreshSucceeded'), 'success');
      await loadCredentials(false);
    },
    'marAgentModels.codexRefreshFailed'
  );
}

async function testCredential(credential: CodexCredentialSummary): Promise<void> {
  await credentialAction(
    credential.id,
    'TEST',
    async () => {
      const result = await credentialService.testCredential(credential.id);
      showMessage(
        translate(
          result.success ? 'marAgentModels.codexTestSucceeded' : 'marAgentModels.codexTestFailed'
        ),
        result.success ? 'success' : 'error'
      );
      await loadCredentials(false);
    },
    'marAgentModels.codexTestFailed'
  );
}

async function removeCredential(credential: CodexCredentialSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      translate('marAgentModels.codexConfirmRemove', { name: credential.name }),
      translate('marAgentModels.remove'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('marAgentModels.remove'),
        cancelButtonText: translate('marAgentModels.cancel')
      }
    );
    await credentialAction(
      credential.id,
      'REMOVE',
      async () => {
        await credentialService.removeCredential(credential.id);
        credentialDetailOpen.value = false;
        showMessage(translate('marAgentModels.codexRemoved'), 'success');
        await loadCredentials(false);
      },
      'marAgentModels.codexRemoveFailed'
    );
  } catch (error) {
    if (error !== 'cancel') showCodexRequestError(error, 'marAgentModels.codexRemoveFailed');
  }
}

async function credentialAction(
  credentialId: string,
  kind: CredentialAction,
  action: () => Promise<void>,
  fallbackKey: string
): Promise<void> {
  if (!beginCredentialAction(credentialId, kind)) return;
  try {
    await action();
  } catch (error) {
    showCodexRequestError(error, fallbackKey);
  } finally {
    finishCredentialAction(credentialId, kind);
  }
}

function credentialActionBusy(credentialId: string): boolean {
  return credentialActions.value.has(credentialId);
}

function credentialActionIs(credentialId: string, kind: CredentialAction): boolean {
  return credentialActions.value.get(credentialId) === kind;
}

function beginCredentialAction(credentialId: string, kind: CredentialAction): boolean {
  if (credentialActionBusy(credentialId)) return false;
  const next = new Map(credentialActions.value);
  next.set(credentialId, kind);
  credentialActions.value = next;
  return true;
}

function finishCredentialAction(credentialId: string, kind: CredentialAction): void {
  if (!credentialActionIs(credentialId, kind)) return;
  const next = new Map(credentialActions.value);
  next.delete(credentialId);
  credentialActions.value = next;
}

async function openCatalog(credential: CodexCredentialSummary): Promise<void> {
  const sequence = ++catalogSequence;
  credentialDetailOpen.value = false;
  catalogCredential.value = credential;
  catalogDialog.value = true;
  catalogLoading.value = true;
  catalogImporting.value = false;
  catalog.value = undefined;
  catalogRows.value = [];
  try {
    await props.prepareCatalog?.(credential);
    if (sequence !== catalogSequence) return;
    const loaded = await credentialService.loadCatalog(credential.id);
    if (sequence !== catalogSequence) return;
    catalog.value = loaded;
    catalogRows.value = loaded.models.map((model) => ({
      upstreamModelId: model.upstreamModelId,
      displayName: model.displayName,
      ...(model.description === undefined ? {} : { description: model.description }),
      selected: false,
      name: model.displayName,
      contextWindowTokens: model.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      warnings: model.warnings,
      reasoningEfforts: model.reasoningEfforts,
      defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
        model.defaultReasoningEffort,
        model.reasoningEfforts
      ),
      unsupportedReasoningEfforts: model.unsupportedReasoningEfforts,
      requiredInputs: model.requiredInputs
    }));
  } catch (error) {
    if (sequence === catalogSequence) {
      showCodexRequestError(error, 'marAgentModels.codexCatalogLoadFailed');
      catalogDialog.value = false;
    }
  } finally {
    if (sequence === catalogSequence) catalogLoading.value = false;
  }
}

async function importCatalogModels(): Promise<void> {
  const sequence = catalogSequence;
  const credential = catalogCredential.value;
  const currentCatalog = catalog.value;
  if (credential === undefined || currentCatalog === undefined) return;
  if (selectedCatalogCount.value === 0) {
    showMessage(translate('marAgentModels.codexCatalogSelectionRequired'), 'warning');
    return;
  }
  if (!(await catalogFormRef.value?.validate().catch(() => false))) return;
  if (sequence !== catalogSequence || catalogImporting.value) return;
  catalogImporting.value = true;
  try {
    const ownership = props.catalogOwnership?.();
    const request = {
      ...buildCodexModelImportRequest(currentCatalog, catalogRows.value),
      ...(ownership === undefined ? {} : { ownership })
    };
    const result = await credentialService.importModels(credential.id, request);
    if (sequence !== catalogSequence) return;
    importResult.value = result;
    catalogDialog.value = false;
    showMessage(translate('marAgentModels.codexImportSucceeded'), 'success');
    await Promise.all([load(false), loadCredentials(false)]);
  } catch (error) {
    if (sequence !== catalogSequence) return;
    if (errorCode(error) === 'CODEX_CATALOG_CHANGED') {
      showMessage(translate('marAgentModels.codexErrorCatalogChanged'), 'warning', error);
      await openCatalog(credential);
    } else if (errorCode(error) === 'CODEX_MODEL_IMPORT_LIMIT_REQUIRED') {
      showMessage(translate('marAgentModels.codexCatalogLimitsRequired'), 'error', error);
    } else {
      showCodexRequestError(error, 'marAgentModels.codexImportFailed');
    }
  } finally {
    if (sequence === catalogSequence) catalogImporting.value = false;
  }
}

function resetCatalogDialog(): void {
  catalogSequence += 1;
  catalogLoading.value = false;
  catalogImporting.value = false;
  catalogCredential.value = undefined;
  catalog.value = undefined;
  catalogRows.value = [];
}

function showCodexRequestError(error: unknown, fallbackKey: string): void {
  const code = errorCode(error);
  const key = code === undefined ? undefined : codexCredentialErrorMessageKey(code);
  showMessage(
    key === undefined
      ? errorMessageOrFallback(error, fallbackKey)
      : errorMessage(error, translate(key)),
    'error',
    error
  );
}

function showCodexError(
  code: string | undefined,
  message: string | undefined,
  fallbackKey: string
) {
  const key = code === undefined ? undefined : codexCredentialErrorMessageKey(code);
  showMessage(key === undefined ? (message ?? translate(fallbackKey)) : translate(key), 'error');
}

function errorMessageOrFallback(error: unknown, fallbackKey: string): string {
  return error instanceof Error ? errorMessage(error) : translate(fallbackKey);
}

function startCountdown(): void {
  countdownNow.value = Date.now();
  if (countdownTimer !== undefined) return;
  countdownTimer = setInterval(() => (countdownNow.value = Date.now()), 1000);
}

function stopCountdown(): void {
  if (countdownTimer !== undefined) clearInterval(countdownTimer);
  countdownTimer = undefined;
}

function transportFromChoice(value: TransportChoice): MarAgentResponsesTransport {
  if (value === 'WEBSOCKET') return { transport: 'WEBSOCKET' };
  return { transport: 'HTTP', httpVersion: value === 'HTTP_2' ? '2' : '1.1' };
}

function serviceTierLabel(model: ModelSummary): string {
  const tier = model.serviceTier ?? (model.fastMode === true ? 'priority' : 'default');
  if (tier === 'default') return translate('marAgentModels.serviceTierDefault');
  if (tier === 'priority' || tier === 'fast') return translate('marAgentModels.serviceTierFast');
  if (tier === 'ultrafast') return translate('marAgentModels.serviceTierUltrafast');
  return tier;
}

function protocolLabel(model: ModelSummary): string {
  const protocol = modelProtocolChoice(model);
  return translate(
    protocol === 'CODEX'
      ? 'marAgentModels.protocolCodex'
      : protocol === 'CHATGPT'
        ? 'marAgentModels.chatgptCredential'
        : protocol === 'GROK'
          ? 'marAgentModels.grokProtocol'
          : protocol === 'OPENAI_RESPONSES'
            ? 'marAgentModels.protocolOpenAI'
            : 'marAgentModels.protocolAnthropic'
  );
}

function statusLabel(status: ModelSummary['lastTestStatus']): string {
  if (status === 'SUCCEEDED') return translate('marAgentModels.statusSucceeded');
  if (status === 'FAILED') return translate('marAgentModels.statusFailed');
  return translate('marAgentModels.statusUnverified');
}

function statusType(status: ModelSummary['lastTestStatus']): TagProps['type'] {
  return status === 'SUCCEEDED' ? 'success' : status === 'FAILED' ? 'danger' : 'info';
}

function statusDetail(model: ModelSummary): string {
  if (model.lastTestStatus !== 'FAILED') return statusLabel(model.lastTestStatus);
  return translate(
    model.lastTestCode === 'MAR_AGENT_MODEL_AUTH_FAILED'
      ? 'marAgentModels.testAuthFailed'
      : 'marAgentModels.testConnectionFailed'
  );
}

function modelTestValue(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function credentialStatusLabel(
  status: CodexCredentialSummary['status'],
  authorization?: CodexCredentialSummary['authorization']
): string {
  if (authorization === 'UNAUTHORIZED') return translate('marAgentModels.chatgptUnauthorized');
  if (status === 'ACTIVE') return translate('marAgentModels.codexStatusActive');
  if (status === 'DEGRADED') return translate('marAgentModels.codexStatusDegraded');
  return translate('marAgentModels.codexStatusReauth');
}

function credentialScopeLabel(ownership: CodexCredentialOwnership): string {
  return (
    props.credentialScopeLabel?.(ownership) ??
    translate('marAgentModels.codexCredentialScopePersonal')
  );
}

function credentialStatusType(
  status: CodexCredentialSummary['status'],
  authorization?: CodexCredentialSummary['authorization']
): TagProps['type'] {
  if (authorization === 'UNAUTHORIZED') return 'warning';
  return status === 'ACTIVE' ? 'success' : status === 'DEGRADED' ? 'warning' : 'danger';
}

function formatTimestamp(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : managementDateTime(value);
}

function subscriptionPeriodLabel(
  period: NonNullable<CodexCredentialUsage['subscription']>['period']
): string {
  if (period === 'WEEKLY') return translate('marAgentModels.grokUsagePeriodWeekly');
  if (period === 'MONTHLY') return translate('marAgentModels.grokUsagePeriodMonthly');
  return translate('marAgentModels.grokUsagePeriodUnknown');
}

function formatUsdCents(value: number | null): string {
  return value === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
}

function formatUsagePercentage(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function formatRemainingUsagePercentage(value: number | null): string {
  return value === null ? '—' : `${Number((100 - value).toFixed(2))}%`;
}

function formatUsageStatsTimeZone(value: string): string {
  const timezone = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset'
  })
    .formatToParts(new Date(`${value}T12:00:00.000Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  return timezone?.replace('GMT', 'UTC') ?? 'UTC';
}

function nodeLabel(node: NodeSummary): string {
  return node.displayName?.trim() || node.id;
}

function importStatusLabel(status: CodexModelImportResult['items'][number]['status']): string {
  return translate(`marAgentModels.codexImportStatus${status}`);
}

async function refreshModels() {
  await load(false);
  return models.value;
}

onMounted(() => {
  void (canManageModels.value ? load() : loadPersonalModels());
});
onBeforeUnmount(() => {
  credentialEditSequence += 1;
  loginPoller.dispose();
  stopCountdown();
});
</script>

<template>
  <section
    v-loading="initialLoading"
    element-loading-custom-class="mar-page-loading"
    class="management-page mar-agent-model-management"
  >
    <el-tabs v-model="activeTab" class="management-tabs">
      <el-tab-pane
        v-if="canManageModels"
        :label="translate('marAgentModels.modelsTab')"
        name="models"
      >
        <div class="table-actions">
          <el-button
            :icon="marIcon('refresh')"
            :loading="loading && modelsReady"
            :disabled="sorting"
            @click="load()"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('marAgentModels.refresh') }}</el-button
          >
          <el-button v-if="writable && !sorting" :icon="marIcon('queue')" @click="startSorting">{{
            translate('marAgentModels.adjustOrder')
          }}</el-button>
          <el-button
            v-if="writable && sorting"
            type="primary"
            :icon="marIcon('check')"
            :loading="savingOrder"
            @click="saveOrder"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('marAgentModels.saveOrder') }}</el-button
          >
          <el-button
            v-if="writable && sorting"
            :icon="marIcon('close')"
            :disabled="savingOrder"
            @click="cancelSorting"
            >{{ translate('marAgentModels.cancel') }}</el-button
          >
          <el-button
            v-if="writable && !sorting"
            type="primary"
            :icon="marIcon('plus')"
            @click="openCreate"
            >{{ translate('marAgentModels.add') }}</el-button
          >
        </div>
        <el-table
          :class="{ 'clickable-rows': !sorting }"
          :data="models"
          @row-click="openModelDetails"
        >
          <el-table-column v-if="sorting" :label="translate('marAgentModels.order')" width="92">
            <template #default="{ row, $index }">
              <div
                class="order-handle"
                :class="{ 'is-dragging': draggedModelId === row.id }"
                :draggable="sorting"
                @dragstart="dragStart(row.id, $event)"
                @dragenter.prevent="dragOver(row.id)"
                @dragover.prevent
                @dragend="draggedModelId = undefined"
              >
                <MarIcon name="queue" /><span>{{ $index + 1 }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="name" :label="translate('marAgentModels.name')" min-width="150" />
          <el-table-column :label="translate('marAgentModels.protocol')" min-width="170">
            <template #default="{ row }">{{ protocolLabel(row) }}</template>
          </el-table-column>
          <el-table-column
            prop="modelId"
            :label="translate('marAgentModels.model')"
            min-width="150"
          />
          <el-table-column :label="translate('marAgentModels.availability')" width="110">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'" effect="plain">{{
                translate(row.enabled ? 'marAgentModels.enabled' : 'marAgentModels.disabled')
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="conversationModel"
            :label="translate('marAgentModels.conversationModel')"
            width="130"
            sortable
          >
            <template #default="{ row }">{{
              translate(
                row.conversationModel !== false ? 'marAgentModels.yes' : 'marAgentModels.no'
              )
            }}</template>
          </el-table-column>
          <slot name="model-access-column" />
          <el-table-column :label="translate('marAgentModels.status')" width="130">
            <template #default="{ row }">
              <el-tag
                :type="statusType(row.lastTestStatus)"
                effect="plain"
                :title="statusDetail(row)"
                >{{ statusLabel(row.lastTestStatus) }}</el-tag
              >
            </template>
          </el-table-column>
          <el-table-column v-if="!sorting" :label="translate('marAgentModels.actions')" width="450">
            <template #default="{ row }">
              <div class="row-actions" @click.stop>
                <el-button
                  v-if="writable"
                  link
                  type="primary"
                  :icon="marIcon('edit')"
                  @click="openEdit(row)"
                  >{{ translate('marAgentModels.edit') }}</el-button
                >
                <el-button
                  v-if="writable"
                  link
                  type="primary"
                  :icon="marIcon('copy')"
                  @click="openEdit(row, true)"
                  >{{ translate('marAgentModels.duplicate') }}</el-button
                >
                <slot name="model-actions" :model="row" />
                <el-button
                  link
                  :icon="marIcon('connection')"
                  :loading="testingIds.has(row.id)"
                  :disabled="!writable || testingIds.has(row.id)"
                  @click="openModelTest(row)"
                  :loading-icon="marIcon('loading-action')"
                  >{{ translate('marAgentModels.test') }}</el-button
                >
                <el-button
                  v-if="writable"
                  link
                  type="danger"
                  :icon="marIcon('delete')"
                  @click="remove(row)"
                  >{{ translate('marAgentModels.remove') }}</el-button
                >
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane :label="translate('marAgentModels.codexCredentialsTab')" name="codexCredentials">
        <div class="table-actions">
          <el-button
            :icon="marIcon('refresh')"
            :loading="credentialLoading && credentialsLoaded"
            @click="loadCredentials()"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('marAgentModels.refresh') }}</el-button
          >
          <el-button
            v-if="writable"
            type="primary"
            :icon="marIcon('plus')"
            @click="openCredentialLogin()"
            >{{ translate('marAgentModels.codexAddCredential') }}</el-button
          >
        </div>
        <el-table class="clickable-rows" :data="credentials" @row-click="openCredentialDetails">
          <el-table-column
            prop="name"
            :label="translate('marAgentModels.credentialName')"
            min-width="160"
          />
          <el-table-column :label="translate('marAgentModels.credentialType')" min-width="160">
            <template #default="{ row }">{{
              translate(
                row.type === 'CHATGPT_OAUTH'
                  ? 'marAgentModels.chatgptCredential'
                  : row.type === 'XAI_OAUTH'
                    ? 'marAgentModels.grokSubscriptionCredential'
                    : 'marAgentModels.codexLegacyCredential'
              )
            }}</template>
          </el-table-column>
          <el-table-column
            :label="translate('marAgentModels.codexCredentialScope')"
            min-width="180"
          >
            <template #default="{ row }">{{ credentialScopeLabel(row.ownership) }}</template>
          </el-table-column>
          <el-table-column :label="translate('marAgentModels.status')" width="140">
            <template #default="{ row }">
              <el-tag :type="credentialStatusType(row.status, row.authorization)" effect="plain">{{
                credentialStatusLabel(row.status, row.authorization)
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="translate('marAgentModels.codexAccount')" min-width="150">
            <template #default="{ row }">{{ row.accountId }}</template>
          </el-table-column>
          <el-table-column :label="translate('marAgentModels.codexTokenExpiry')" min-width="180">
            <template #default="{ row }">{{ formatTimestamp(row.accessTokenExpiresAt) }}</template>
          </el-table-column>
          <el-table-column
            :label="translate('marAgentModels.chatgptEarliestRefresh')"
            min-width="180"
          >
            <template #default="{ row }">{{ formatTimestamp(row.earliestRefreshAt) }}</template>
          </el-table-column>
          <el-table-column :label="translate('marAgentModels.actions')" width="350">
            <template #default="{ row }">
              <div class="row-actions" @click.stop>
                <el-button
                  v-if="writable"
                  link
                  type="primary"
                  :icon="marIcon('edit')"
                  :loading="credentialActionIs(row.id, 'EDIT')"
                  :disabled="credentialActionBusy(row.id)"
                  @click="openCredentialEdit(row)"
                  :loading-icon="marIcon('loading-action')"
                >
                  {{ translate('marAgentModels.edit') }}
                </el-button>
                <el-button
                  v-if="writable"
                  link
                  :icon="marIcon('connection')"
                  :loading="credentialActionIs(row.id, 'TEST')"
                  :disabled="credentialActionBusy(row.id)"
                  @click="testCredential(row)"
                  :loading-icon="marIcon('loading-action')"
                >
                  {{ translate('marAgentModels.test') }}
                </el-button>
                <el-button
                  v-if="writable"
                  link
                  type="danger"
                  :icon="marIcon('delete')"
                  :loading="credentialActionIs(row.id, 'REMOVE')"
                  :disabled="credentialActionBusy(row.id)"
                  @click="removeCredential(row)"
                  :loading-icon="marIcon('loading-action')"
                >
                  {{ translate('marAgentModels.remove') }}
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane
        v-if="canManageModels"
        :label="translate('marAgentModels.imageGenerationTab')"
        name="imageGeneration"
      >
        <ImageGenerationManagement
          v-if="activeTab === 'imageGeneration'"
          :request="request"
          :writable="writable"
        />
      </el-tab-pane>
      <el-tab-pane
        v-if="canManageCompact !== false"
        :label="translate('promptCompletion.advanced')"
        name="compact"
      >
        <template v-if="activeTab === 'compact'">
          <h3>{{ translate('promptCompletion.compact') }}</h3>
          <MarAgentCompactSettings
            :request="request"
            :writable="writable"
            :preferred-organization-id="compactPreferredOrganizationId"
          />
          <el-divider />
          <h3>{{ translate('promptCompletion.title') }}</h3>
          <PromptCompletionSettings
            :request="request"
            :writable="writable"
            :preferred-organization-id="compactPreferredOrganizationId"
          />
        </template>
      </el-tab-pane>
      <el-tab-pane :label="translate('marAgentModels.personalOrderTab')" name="modelOrder">
        <p class="selection-rule">{{ translate('marAgentModels.personalOrderHint') }}</p>
        <div class="table-actions">
          <el-button
            :icon="marIcon('refresh')"
            :loading="personalOrderLoading && personalOrderReady"
            :disabled="personalSorting"
            @click="loadPersonalModels()"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('marAgentModels.refresh') }}</el-button
          >
          <el-button
            v-if="writable && !personalSorting"
            :icon="marIcon('queue')"
            @click="startPersonalSorting"
            >{{ translate('marAgentModels.adjustPersonalOrder') }}</el-button
          >
          <el-button
            v-if="writable && personalSorting"
            type="primary"
            :icon="marIcon('check')"
            :loading="savingPersonalOrder"
            @click="savePersonalOrder"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('marAgentModels.saveOrder') }}</el-button
          >
          <el-button
            v-if="writable && personalSorting"
            :icon="marIcon('close')"
            :disabled="savingPersonalOrder"
            @click="cancelPersonalSorting"
            >{{ translate('marAgentModels.cancel') }}</el-button
          >
        </div>
        <el-table :data="personalModels">
          <el-table-column
            v-if="personalSorting"
            :label="translate('marAgentModels.order')"
            width="92"
          >
            <template #default="{ row, $index }">
              <div
                class="order-handle"
                :class="{ 'is-dragging': draggedPersonalModelId === row.id }"
                :draggable="personalSorting"
                @dragstart="personalDragStart(row.id, $event)"
                @dragenter.prevent="personalDragOver(row.id)"
                @dragover.prevent
                @dragend="draggedPersonalModelId = undefined"
              >
                <MarIcon name="queue" /><span>{{ $index + 1 }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="name" :label="translate('marAgentModels.name')" min-width="150" />
          <el-table-column :label="translate('marAgentModels.protocol')" min-width="170">
            <template #default="{ row }">{{ protocolLabel(row) }}</template>
          </el-table-column>
          <el-table-column
            prop="modelId"
            :label="translate('marAgentModels.model')"
            min-width="150"
          />
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-if="dialog"
      v-model="dialog"
      :title="
        duplicatingId
          ? translate('marAgentModels.duplicate')
          : editingId
            ? translate('marAgentModels.edit')
            : translate('marAgentModels.add')
      "
      width="min(720px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <el-form
        ref="formRef"
        :model="modelFormModel"
        :rules="{ ...modelOwnershipRules, ...rules }"
        label-position="top"
      >
        <slot name="model-ownership" :editing="editingId !== undefined" />
        <p v-if="duplicatingId" class="form-hint">
          {{ translate('marAgentModels.duplicateHint') }}
        </p>
        <div class="model-grid">
          <el-form-item :label="translate('marAgentModels.name')" prop="name">
            <el-input v-model="draft.name" />
          </el-form-item>
          <el-form-item :label="translate('marAgentModels.protocol')" prop="protocol">
            <el-select
              :model-value="draft.protocol"
              @change="changeProtocol"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
            >
              <el-option :label="translate('marAgentModels.protocolCodex')" value="CODEX" />
              <el-option :label="translate('marAgentModels.chatgptCredential')" value="CHATGPT" />
              <el-option :label="translate('marAgentModels.grokProtocol')" value="GROK" />
              <el-option
                :label="translate('marAgentModels.protocolAnthropic')"
                value="ANTHROPIC_MESSAGES"
              />
              <el-option
                :label="translate('marAgentModels.protocolOpenAI')"
                value="OPENAI_RESPONSES"
              />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item
          v-if="!isOAuthProtocol(draft.protocol)"
          :label="translate('marAgentModels.url')"
          prop="baseUrl"
        >
          <el-input v-model="draft.baseUrl" />
        </el-form-item>
        <el-form-item
          v-if="isOAuthProtocol(draft.protocol)"
          :label="translate('marAgentModels.codexCredential')"
          prop="credentialId"
        >
          <el-select
            v-model="draft.credentialId"
            filterable
            :placeholder="
              canKeepCredential
                ? translate('marAgentModels.credentialKeepHint')
                : translate('marAgentModels.credentialSelect')
            "
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="credential in availableModelCredentials"
              :key="credential.id"
              :label="credential.name"
              :value="credential.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-else :label="translate('marAgentModels.key')" prop="apiKey">
          <el-input
            v-model="draft.apiKey"
            type="password"
            show-password
            :placeholder="canKeepCredential ? translate('marAgentModels.keyHint') : ''"
            ><template #password-icon="{ visible }"
              ><MarIcon :name="visible ? 'view' : 'view-off'" /></template
          ></el-input>
        </el-form-item>
        <el-form-item :label="translate('marAgentModels.model')" prop="modelId">
          <el-input v-model="draft.modelId" maxlength="256" />
        </el-form-item>
        <div class="model-grid">
          <el-form-item :label="translate('marAgentModels.context')">
            <el-input-number v-model="draft.contextWindowTokens" :min="1"
              ><template #decrease-icon><MarIcon name="subtract" /></template
              ><template #increase-icon><MarIcon name="plus" /></template
            ></el-input-number>
          </el-form-item>
          <el-form-item :label="translate('marAgentModels.output')" prop="maxOutputTokens">
            <el-input-number v-model="draft.maxOutputTokens" :min="1"
              ><template #decrease-icon><MarIcon name="subtract" /></template
              ><template #increase-icon><MarIcon name="plus" /></template
            ></el-input-number>
          </el-form-item>
        </div>
        <el-form-item
          v-if="draft.protocol !== 'ANTHROPIC_MESSAGES'"
          :label="translate('marAgentModels.transport')"
        >
          <el-select
            v-model="responsesTransportChoice"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option :label="translate('marAgentModels.transportWebSocket')" value="WEBSOCKET" />
            <el-option
              v-if="draft.protocol !== 'GROK'"
              :label="translate('marAgentModels.transportHttp2')"
              value="HTTP_2"
            />
            <el-option :label="translate('marAgentModels.transportHttp1')" value="HTTP_1_1" />
          </el-select>
          <p class="form-hint">{{ translate('marAgentModels.transportStoreHint') }}</p>
        </el-form-item>
        <el-form-item
          v-if="isOAuthProtocol(draft.protocol) && draft.protocol !== 'GROK'"
          :label="translate('marAgentModels.serviceTier')"
        >
          <el-select
            v-model="draft.serviceTier"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option :label="translate('marAgentModels.serviceTierDefault')" value="default" />
            <el-option :label="translate('marAgentModels.serviceTierFast')" value="priority" />
            <el-option
              :label="translate('marAgentModels.serviceTierUltrafast')"
              value="ultrafast"
            />
          </el-select>
        </el-form-item>
        <el-form-item class="model-enabled" :label="translate('marAgentModels.enabled')">
          <el-switch v-model="draft.enabled" />
        </el-form-item>
        <el-form-item :label="translate('marAgentModels.capabilities')">
          <el-checkbox
            :model-value="draft.inputCapabilities.includes('IMAGE')"
            @change="
              (value: boolean | string | number) =>
                (draft.inputCapabilities = Boolean(value) ? ['TEXT', 'IMAGE'] : ['TEXT'])
            "
            >{{ translate('marAgentModels.image') }}</el-checkbox
          >
          <el-checkbox v-model="draft.conversationModel">{{
            translate('marAgentModels.conversationModel')
          }}</el-checkbox>
          <el-checkbox v-model="draft.titleGeneration">{{
            translate('marAgentModels.titleGeneration')
          }}</el-checkbox>
          <el-checkbox v-model="draft.codeMode">{{
            translate('marAgentModels.codeMode')
          }}</el-checkbox>
          <el-checkbox
            v-model="draft.hostedWebSearch"
            :disabled="draft.protocol === 'ANTHROPIC_MESSAGES'"
            >{{ translate('marAgentModels.webSearch') }}</el-checkbox
          >
          <el-checkbox
            v-model="draft.responsesPreviousResponseId"
            :disabled="draft.protocol === 'ANTHROPIC_MESSAGES'"
            >{{ translate('marAgentModels.responsesContinuation') }}</el-checkbox
          >
        </el-form-item>
        <el-form-item :label="translate('marAgentModels.reasoningEfforts')">
          <el-checkbox-group v-model="draft.reasoningEfforts">
            <el-checkbox
              v-for="effort in reasoningEffortOptions"
              :key="effort"
              :label="effort"
              :value="effort"
            >
              {{ effort }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item
          :label="translate('marAgentModels.defaultReasoningEffort')"
          prop="defaultReasoningEffort"
        >
          <el-select
            v-model="draft.defaultReasoningEffort"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="effort in defaultReasoningEffortOptions"
              :key="effort"
              :label="effort"
              :value="effort"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ translate('marAgentModels.cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="saving"
          @click="save"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('marAgentModels.save') }}</el-button
        >
      </template>
    </el-dialog>

    <el-dialog
      v-if="modelTestDialog && modelTestModel"
      v-model="modelTestDialog"
      :title="translate('marAgentModels.modelTestTitle')"
      width="min(520px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <p class="dialog-summary">{{ translate('marAgentModels.modelTestSummary') }}</p>
      <el-form label-position="top">
        <el-form-item :label="translate('marAgentModels.name')">
          <el-input :model-value="modelTestModel.name" disabled />
        </el-form-item>
        <el-form-item :label="translate('marAgentModels.modelTestNode')">
          <el-select
            v-model="modelTestNodeId"
            :placeholder="translate('marAgentModels.modelTestNodeRequired')"
            filterable
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="node in eligibleTestNodes"
              :key="node.id"
              :label="nodeLabel(node)"
              :value="node.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <section v-if="modelTestResult" class="model-test-result" aria-live="polite">
        <h3>{{ translate('marAgentModels.modelTestResultTitle') }}</h3>
        <div class="model-test-result-heading">
          <el-tag :type="modelTestResult.success ? 'success' : 'danger'">
            {{
              translate(
                modelTestResult.success
                  ? 'marAgentModels.modelTestSuccess'
                  : 'marAgentModels.modelTestFailure'
              )
            }}
          </el-tag>
        </div>
        <el-descriptions :column="1" border>
          <el-descriptions-item :label="translate('marAgentModels.modelTestCode')">
            {{ modelTestValue(modelTestResult.code) }}
          </el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.modelTestHttpStatus')">
            {{ modelTestValue(modelTestResult.httpStatus) }}
          </el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.modelTestMessage')">
            {{ modelTestValue(modelTestResult.message) }}
          </el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.modelTestServerRequestId')">
            {{ modelTestValue(modelTestResult.requestId) }}
          </el-descriptions-item>
        </el-descriptions>
        <template v-if="!modelTestResult.success && modelTestResult.response">
          <el-descriptions class="model-test-response-details" :column="1" border>
            <el-descriptions-item :label="translate('marAgentModels.modelTestUpstreamRequestId')">
              {{ modelTestValue(modelTestResult.response.requestId) }}
            </el-descriptions-item>
            <el-descriptions-item :label="translate('marAgentModels.modelTestContentType')">
              {{ modelTestValue(modelTestResult.response.contentType) }}
            </el-descriptions-item>
            <el-descriptions-item :label="translate('marAgentModels.modelTestRetryAfter')">
              {{ modelTestValue(modelTestResult.response.retryAfter) }}
            </el-descriptions-item>
          </el-descriptions>
          <div class="model-test-response-body-label">
            {{ translate('marAgentModels.modelTestResponseBody') }}
          </div>
          <el-input
            class="model-test-response-body"
            type="textarea"
            readonly
            :model-value="modelTestResult.response.body"
            :autosize="{ minRows: 3, maxRows: 12 }"
          />
          <p v-if="modelTestResult.response.bodyTruncated" class="form-hint">
            {{ translate('marAgentModels.modelTestResponseBodyTruncated') }}
          </p>
        </template>
      </section>
      <template #footer>
        <el-button @click="modelTestDialog = false">{{
          translate('marAgentModels.cancel')
        }}</el-button>
        <el-button
          type="primary"
          :icon="marIcon('connection')"
          :disabled="!modelTestNodeId"
          :loading="testingIds.has(modelTestModel.id)"
          @click="test(modelTestModel)"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('marAgentModels.test') }}</el-button
        >
      </template>
    </el-dialog>

    <slot name="model-extensions" :refresh="refreshModels" />
    <el-dialog
      v-if="credentialDialog"
      v-model="credentialDialog"
      :title="
        credentialEditId
          ? translate('marAgentModels.codexEditCredentialTitle')
          : credentialDraft.targetCredentialId
            ? translate('marAgentModels.codexReloginTitle')
            : translate('marAgentModels.codexAddCredential')
      "
      width="min(620px, calc(100vw - 32px))"
      @closed="resetCredentialDialog"
      :close-icon="marIcon('close')"
    >
      <el-form
        ref="credentialFormRef"
        :model="{ ...credentialContext, ...credentialDraft }"
        :rules="{ ...credentialOwnershipRules, ...credentialRules }"
        label-position="top"
      >
        <el-form-item :label="translate('marAgentModels.credentialType')">
          <el-select
            v-model="credentialDraft.type"
            :disabled="
              credentialEditId !== undefined || credentialDraft.targetCredentialId !== undefined
            "
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              value="CODEX_OAUTH"
              :label="translate('marAgentModels.codexLegacyCredential')"
            />
            <el-option
              value="CHATGPT_OAUTH"
              :label="translate('marAgentModels.chatgptCredential')"
            />
            <el-option
              value="XAI_OAUTH"
              :label="translate('marAgentModels.grokSubscriptionCredential')"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="credentialDraft.type === 'CHATGPT_OAUTH' && credentialEditId === undefined"
          :label="translate('marAgentModels.chatgptLocalNode')"
          prop="nodeId"
        >
          <el-select
            v-model="credentialDraft.nodeId"
            filterable
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="node in eligibleLoginNodes"
              :key="node.id"
              :value="node.id"
              :label="node.displayName ?? node.registeredAddress"
            />
          </el-select>
          <span class="form-hint">{{ translate('marAgentModels.chatgptLocalNodeHint') }}</span>
        </el-form-item>
        <el-form-item :label="translate('marAgentModels.credentialName')" prop="name">
          <el-input v-model="credentialDraft.name" />
        </el-form-item>
        <slot name="credential-ownership">
          <el-form-item :label="translate('marAgentModels.codexCredentialScope')">
            <el-select
              model-value="PERSONAL"
              :clear-icon="marIcon('clear-input')"
              :suffix-icon="marIcon('chevron-down')"
              ><el-option
                value="PERSONAL"
                :label="translate('marAgentModels.codexCredentialScopePersonal')"
            /></el-select>
          </el-form-item>
        </slot>
        <p v-if="credentialDraft.type === 'XAI_OAUTH'" class="dialog-summary">
          {{ translate('marAgentModels.grokExperimentalHint') }}
        </p>
        <el-form-item :label="translate('marAgentModels.codexProxy')" prop="socks5Url">
          <el-input
            v-model="credentialDraft.socks5Url"
            :placeholder="translate('marAgentModels.codexProxyPlaceholder')"
          />
          <span class="form-hint">
            {{
              translate(
                credentialDraft.type === 'XAI_OAUTH'
                  ? 'marAgentModels.grokProxyHint'
                  : 'marAgentModels.codexProxyHint'
              )
            }}
          </span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credentialDialog = false">{{
          translate('marAgentModels.cancel')
        }}</el-button>
        <el-button
          type="primary"
          :loading="credentialSaving"
          @click="submitCredentialLogin"
          :loading-icon="marIcon('loading-action')"
          >{{
            translate(
              credentialEditId
                ? 'marAgentModels.save'
                : credentialDraft.type === 'CHATGPT_OAUTH'
                  ? 'marAgentModels.chatgptStartLogin'
                  : 'marAgentModels.codexStartLogin'
            )
          }}</el-button
        >
      </template>
    </el-dialog>

    <el-dialog
      v-if="loginAttemptDialog && loginAttempt"
      v-model="loginAttemptDialog"
      :title="
        translate(
          loginAttempt.type === 'CHATGPT_OAUTH'
            ? 'marAgentModels.chatgptLoginTitle'
            : loginAttempt.type === 'XAI_OAUTH'
              ? 'marAgentModels.grokLoginTitle'
              : 'marAgentModels.codexDeviceLoginTitle'
        )
      "
      width="min(560px, calc(100vw - 32px))"
      :show-close="loginAttempt.status !== 'PENDING'"
      :close-on-click-modal="false"
      :close-on-press-escape="loginAttempt.status !== 'PENDING'"
      :close-icon="marIcon('close')"
    >
      <template v-if="loginAttempt.status === 'PENDING'">
        <p class="dialog-summary">
          {{
            translate(
              loginAttempt.type === 'CHATGPT_OAUTH'
                ? 'marAgentModels.chatgptLoginHint'
                : loginAttempt.type === 'XAI_OAUTH'
                  ? 'marAgentModels.grokDeviceLoginSummary'
                  : 'marAgentModels.codexDeviceLoginSummary'
            )
          }}
        </p>
        <div v-if="loginAttempt.userCode" class="device-login-code">
          {{ loginAttempt.userCode }}
        </div>
        <el-link
          :href="loginAttempt.verificationUri"
          :underline="false"
          target="_blank"
          type="primary"
        >
          {{ loginAttempt.verificationUri }}
        </el-link>
        <p class="form-hint">
          {{
            translate(
              loginAttempt.type === 'CHATGPT_OAUTH'
                ? 'marAgentModels.chatgptLoginExpires'
                : loginAttempt.type === 'XAI_OAUTH'
                  ? 'marAgentModels.grokDeviceLoginExpires'
                  : 'marAgentModels.codexDeviceLoginExpires',
              { seconds: loginAttemptSeconds }
            )
          }}
        </p>
      </template>
      <el-result
        v-else-if="loginAttempt.status === 'SUCCEEDED'"
        icon="success"
        :title="translate('marAgentModels.codexLoginSucceeded')"
        ><template #icon
          ><MarIcon
            name="success"
            size="64"
            style="color: var(--mar-color-success-text)" /></template
      ></el-result>
      <el-result
        v-else
        icon="error"
        :title="translate('marAgentModels.codexLoginFailed')"
        :sub-title="loginAttempt.code ?? loginAttempt.message"
        ><template #icon
          ><MarIcon name="error" size="64" style="color: var(--mar-color-danger-text)" /></template
      ></el-result>
      <template #footer>
        <template v-if="loginAttempt.status === 'PENDING'">
          <el-button
            :icon="marIcon('refresh')"
            :loading="loginAttemptRefreshing"
            @click="refreshLoginAttempt"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('marAgentModels.codexRefreshLoginStatus') }}</el-button
          >
          <el-button @click="cancelLoginAttempt">{{
            translate('marAgentModels.cancel')
          }}</el-button>
        </template>
        <el-button v-else type="primary" @click="loginAttemptDialog = false">{{
          translate('marAgentModels.close')
        }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-if="modelDetailOpen && selectedModelDetail"
      v-model="modelDetailOpen"
      :title="translate('marAgentModels.details')"
      width="min(720px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <el-descriptions class="mar-detail-descriptions" :column="1" border>
        <el-descriptions-item :label="translate('marAgentModels.modelConfigurationId')">
          <code>{{ selectedModelDetail.id }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.name')">{{
          selectedModelDetail.name
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.protocol')">{{
          protocolLabel(selectedModelDetail)
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.model')">{{
          selectedModelDetail.modelId
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.url')">
          <code class="model-detail-url">{{ selectedModelDetail.baseUrl }}</code>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.availability')">
          <el-tag :type="selectedModelDetail.enabled ? 'success' : 'info'" effect="plain">{{
            translate(
              selectedModelDetail.enabled ? 'marAgentModels.enabled' : 'marAgentModels.disabled'
            )
          }}</el-tag>
        </el-descriptions-item>
        <slot name="model-access-details" :model="selectedModelDetail" />
        <el-descriptions-item :label="translate('marAgentModels.status')">
          <el-tag :type="statusType(selectedModelDetail.lastTestStatus)" effect="plain">{{
            statusLabel(selectedModelDetail.lastTestStatus)
          }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.context')">{{
          selectedModelDetail.contextWindowTokens
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.output')">{{
          selectedModelDetail.maxOutputTokens
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.defaultReasoningEffort')">{{
          selectedModelDetail.defaultReasoningEffort
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.conversationModel')">{{
          translate(
            selectedModelDetail.conversationModel !== false
              ? 'marAgentModels.yes'
              : 'marAgentModels.no'
          )
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.titleGeneration')">{{
          translate(
            selectedModelDetail.titleGeneration ? 'marAgentModels.yes' : 'marAgentModels.no'
          )
        }}</el-descriptions-item>
        <el-descriptions-item :label="translate('marAgentModels.codeMode')">{{
          translate(selectedModelDetail.codeMode ? 'marAgentModels.yes' : 'marAgentModels.no')
        }}</el-descriptions-item>
        <el-descriptions-item
          v-if="
            selectedModelDetail.credentialType === 'CREDENTIAL_REF' &&
            modelProtocolChoice(selectedModelDetail) !== 'GROK'
          "
          :label="translate('marAgentModels.serviceTier')"
          >{{ serviceTierLabel(selectedModelDetail) }}</el-descriptions-item
        >
      </el-descriptions>
      <template #footer>
        <el-button @click="modelDetailOpen = false">{{ translate('common.close') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-if="credentialDetailOpen"
      v-model="credentialDetailOpen"
      :title="translate('marAgentModels.codexCredentialDetails')"
      width="min(720px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <div v-loading="credentialDetailLoading">
        <el-descriptions v-if="selectedCredentialDetails" :column="1" border>
          <el-descriptions-item :label="translate('marAgentModels.codexCredentialId')">
            <code>{{ selectedCredentialDetails.credential.id }}</code>
          </el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.credentialName')">{{
            selectedCredentialDetails.credential.name
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.codexCredentialScope')">{{
            credentialScopeLabel(selectedCredentialDetails.credential.ownership)
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.status')">{{
            credentialStatusLabel(
              selectedCredentialDetails.credential.status,
              selectedCredentialDetails.credential.authorization
            )
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.codexAccount')">{{
            selectedCredentialDetails.credential.accountId
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.codexTokenExpiry')">{{
            formatTimestamp(selectedCredentialDetails.credential.accessTokenExpiresAt)
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.chatgptEarliestRefresh')">{{
            formatTimestamp(selectedCredentialDetails.credential.earliestRefreshAt)
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.codexLastRefresh')">{{
            formatTimestamp(selectedCredentialDetails.credential.lastRefreshAt)
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.codexLastChecked')">{{
            formatTimestamp(selectedCredentialDetails.credential.lastCheckedAt)
          }}</el-descriptions-item>
          <el-descriptions-item :label="translate('marAgentModels.codexProxy')">
            <code class="credential-proxy-url">{{
              selectedCredentialDetails.socks5Url ?? '—'
            }}</code>
          </el-descriptions-item>
        </el-descriptions>
        <section
          v-if="
            selectedCredentialUsage && selectedCredentialDetails?.credential.type === 'XAI_OAUTH'
          "
          class="credential-usage"
        >
          <h3>{{ translate('marAgentModels.grokUsageTitle') }}</h3>
          <div class="credential-usage-summary">
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.grokUsagePercentage') }}</span>
              <strong>{{
                formatUsagePercentage(selectedCredentialUsage.subscription?.usedPercentage ?? null)
              }}</strong>
            </div>
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.grokUsageRemainingPercentage') }}</span>
              <strong>{{
                formatRemainingUsagePercentage(
                  selectedCredentialUsage.subscription?.usedPercentage ?? null
                )
              }}</strong>
            </div>
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.grokUsagePeriod') }}</span>
              <strong>{{
                selectedCredentialUsage.subscription
                  ? subscriptionPeriodLabel(selectedCredentialUsage.subscription.period)
                  : '—'
              }}</strong>
            </div>
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.grokUsageResetsAt') }}</span>
              <strong>{{
                formatTimestamp(selectedCredentialUsage.subscription?.resetsAt ?? null)
              }}</strong>
            </div>
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.grokUsagePrepaidBalance') }}</span>
              <strong>{{
                formatUsdCents(selectedCredentialUsage.subscription?.prepaidBalanceCents ?? null)
              }}</strong>
            </div>
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.grokUsageQueriedAt') }}</span>
              <strong>{{ formatTimestamp(selectedCredentialUsage.fetchedAt) }}</strong>
            </div>
          </div>
        </section>
        <section v-else-if="selectedCredentialUsage" class="credential-usage">
          <h3>{{ translate('marAgentModels.codexUsageTitle') }}</h3>
          <div class="credential-usage-summary">
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.codexUsageLifetimeTokens') }}</span>
              <strong>{{
                codexUsageTokenCountLabel(selectedCredentialUsage.profile.lifetimeTokens)
              }}</strong>
            </div>
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.codexUsageCurrentDayTokens') }}</span>
              <strong>{{
                codexUsageTokenCountLabel(selectedCredentialUsage.profile.currentDayTokens)
              }}</strong>
              <small v-if="selectedCredentialUsage.profile.statsAsOf" class="credential-usage-date">
                {{
                  translate('marAgentModels.codexUsageStatsAsOf', {
                    value: selectedCredentialUsage.profile.statsAsOf,
                    timezone: formatUsageStatsTimeZone(selectedCredentialUsage.profile.statsAsOf)
                  })
                }}
              </small>
            </div>
            <div class="credential-usage-metric">
              <span>{{ translate('marAgentModels.codexUsageLastSevenDaysTokens') }}</span>
              <strong>{{
                codexUsageTokenCountLabel(selectedCredentialUsage.profile.lastSevenDaysTokens)
              }}</strong>
            </div>
          </div>
          <h4>{{ translate('marAgentModels.codexUsageLimitsTitle') }}</h4>
          <el-descriptions :column="1" border>
            <el-descriptions-item
              v-for="(window, index) in selectedCredentialUsage.windows"
              :key="`${window.id}-${index}`"
              :label="runnerUsageWindowLabel(window)"
            >
              <div class="credential-usage-window">
                <strong>{{
                  translate('marAgentModels.codexUsageUsed', {
                    percentage: window.usedPercentage
                  })
                }}</strong>
                <span>{{
                  translate('marAgentModels.codexUsageResetsAt', {
                    value: formatTimestamp(window.resetsAt)
                  })
                }}</span>
              </div>
            </el-descriptions-item>
            <el-descriptions-item :label="translate('marAgentModels.codexUsageQueriedAt')">
              {{ formatTimestamp(selectedCredentialUsage.fetchedAt) }}
            </el-descriptions-item>
          </el-descriptions>
        </section>
      </div>
      <template #footer>
        <div v-if="selectedCredentialDetails" class="credential-detail-actions">
          <ChatGPTManageUsageButton
            v-if="selectedCredentialDetails.credential.type === 'CHATGPT_OAUTH'"
          />
          <el-button
            v-if="
              selectedCredentialDetails.credential.type === 'CODEX_OAUTH' ||
              selectedCredentialDetails.credential.type === 'XAI_OAUTH'
            "
            :icon="marIcon('info')"
            :loading="credentialUsageLoading"
            @click="loadCredentialUsage(selectedCredentialDetails.credential.id)"
            :loading-icon="marIcon('loading-action')"
            >{{ translate('marAgentModels.codexQueryUsage') }}</el-button
          >
          <template v-if="writable">
            <el-button
              :icon="marIcon('refresh')"
              :loading="credentialActionIs(selectedCredentialDetails.credential.id, 'REFRESH')"
              :disabled="credentialActionBusy(selectedCredentialDetails.credential.id)"
              @click="refreshCredential(selectedCredentialDetails.credential)"
              :loading-icon="marIcon('loading-action')"
              >{{ translate('marAgentModels.codexRefresh') }}</el-button
            >
            <el-button
              :icon="marIcon('key')"
              @click="openCredentialLogin(selectedCredentialDetails.credential)"
              >{{ translate('marAgentModels.codexRelogin') }}</el-button
            >
            <el-button
              v-if="canManageModels"
              :icon="marIcon('plus')"
              @click="openCatalog(selectedCredentialDetails.credential)"
              >{{ translate('marAgentModels.codexLoadCatalog') }}</el-button
            >
          </template>
        </div>
        <el-button @click="credentialDetailOpen = false">{{
          translate('marAgentModels.close')
        }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-if="catalogDialog"
      v-model="catalogDialog"
      :title="translate('marAgentModels.codexCatalogTitle')"
      width="min(1180px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <p v-if="catalogCredential" class="dialog-summary">
        {{ translate('marAgentModels.codexCatalogSummary', { name: catalogCredential.name }) }}
      </p>
      <el-form
        ref="catalogFormRef"
        :model="catalogContext ?? {}"
        :rules="catalogOwnershipRules"
        label-position="top"
      >
        <slot name="catalog-ownership" />
      </el-form>
      <div v-loading="catalogLoading" class="catalog-table-wrap">
        <el-table :data="catalogRows" row-key="upstreamModelId">
          <el-table-column :label="translate('marAgentModels.select')" width="80">
            <template #default="{ row }"><el-checkbox v-model="row.selected" /></template>
          </el-table-column>
          <el-table-column :label="translate('marAgentModels.model')" min-width="220">
            <template #default="{ row }">
              <strong>{{ row.displayName }}</strong>
              <code class="catalog-model-id">{{ row.upstreamModelId }}</code>
              <div class="catalog-reasoning">
                <span class="catalog-reasoning-label">{{
                  translate('marAgentModels.codexCatalogReasoningSupported')
                }}</span>
                <span>{{ row.reasoningEfforts.join(', ') || '—' }}</span>
              </div>
              <div class="catalog-reasoning">
                <span class="catalog-reasoning-label">{{
                  translate('marAgentModels.codexCatalogReasoningDefault')
                }}</span>
                <span>{{ row.defaultReasoningEffort }}</span>
              </div>
              <div class="catalog-reasoning">
                <span class="catalog-reasoning-label">{{
                  translate('marAgentModels.codexCatalogReasoningUnsupported')
                }}</span>
                <span>{{ row.unsupportedReasoningEfforts.join(', ') || '—' }}</span>
              </div>
              <el-alert
                v-if="row.warnings.length"
                :title="translate('marAgentModels.codexCatalogWarning')"
                type="warning"
                :closable="false"
              />
            </template>
          </el-table-column>
          <el-table-column :label="translate('marAgentModels.name')" min-width="180">
            <template #default="{ row }"
              ><el-input v-model="row.name" :disabled="!row.selected"
            /></template>
          </el-table-column>
          <el-table-column :label="translate('marAgentModels.context')" min-width="150">
            <template #default="{ row }">
              <el-input-number
                v-if="row.requiredInputs.includes('contextWindowTokens')"
                v-model="row.contextWindowTokens"
                :min="1"
                :disabled="!row.selected"
                ><template #decrease-icon><MarIcon name="subtract" /></template
                ><template #increase-icon><MarIcon name="plus" /></template
              ></el-input-number>
              <span v-else>{{ row.contextWindowTokens }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <span class="dialog-footer-summary">{{
          translate('marAgentModels.codexCatalogSelected', { count: selectedCatalogCount })
        }}</span>
        <el-button @click="catalogDialog = false">{{
          translate('marAgentModels.cancel')
        }}</el-button>
        <el-button
          type="primary"
          :disabled="selectedCatalogCount === 0"
          :loading="catalogImporting"
          @click="importCatalogModels"
          :loading-icon="marIcon('loading-action')"
          >{{ translate('marAgentModels.codexImport') }}</el-button
        >
      </template>
    </el-dialog>

    <el-dialog
      v-if="importResultDialog"
      v-model="importResultDialog"
      :title="translate('marAgentModels.codexImportResultTitle')"
      width="min(640px, calc(100vw - 32px))"
      :close-icon="marIcon('close')"
    >
      <el-table :data="importResult?.items ?? []">
        <el-table-column
          prop="upstreamModelId"
          :label="translate('marAgentModels.model')"
          min-width="220"
        />
        <el-table-column :label="translate('marAgentModels.status')" width="140">
          <template #default="{ row }">{{ importStatusLabel(row.status) }}</template>
        </el-table-column>
        <el-table-column
          prop="code"
          :label="translate('marAgentModels.resultCode')"
          min-width="180"
        />
      </el-table>
      <template #footer>
        <el-button type="primary" @click="importResultDialog = false">{{
          translate('marAgentModels.close')
        }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.mar-agent-model-management .selection-rule {
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-body);
  margin: 0 0 12px;
}
.table-actions {
  margin-bottom: 16px;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.model-detail-url {
  overflow-wrap: anywhere;
}
.model-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.dialog-summary {
  margin: 0 0 16px;
  color: var(--mar-text-secondary);
  line-height: 1.6;
}
.model-test-result {
  margin-top: 20px;
}
.model-test-result h3 {
  margin: 0 0 10px;
  font-size: var(--mar-font-size-title);
}
.model-test-result-heading {
  margin-bottom: 12px;
}
.model-test-response-details {
  margin-top: 12px;
}
.model-test-response-body-label {
  margin: 16px 0 6px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.model-test-response-body :deep(textarea) {
  font-family: inherit;
  overflow-wrap: anywhere;
}
.form-hint {
  display: block;
  width: 100%;
  margin-top: 6px;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}
.device-login-code {
  width: fit-content;
  margin: 18px 0 12px;
  padding: 12px 18px;
  border: 1px solid var(--mar-border-subtle);
  border-radius: var(--mar-radius-surface);
  background: var(--mar-fill-subtle);
  color: var(--mar-text-primary);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-display);
  font-weight: 600;
  letter-spacing: 0.12em;
}
.catalog-table-wrap {
  min-height: 180px;
  overflow-x: auto;
}
.catalog-model-id {
  display: block;
  margin-top: 4px;
  color: var(--mar-text-muted);
  overflow-wrap: anywhere;
}
.catalog-reasoning {
  display: grid;
  grid-template-columns: minmax(120px, auto) 1fr;
  gap: 8px;
  margin-top: 8px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
}
.catalog-reasoning-label {
  color: var(--mar-text-muted);
}
.dialog-footer-summary {
  float: left;
  padding-block: 8px;
  color: var(--mar-text-secondary);
}
.credential-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.credential-detail-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.credential-proxy-url {
  overflow-wrap: anywhere;
}
.credential-usage {
  margin-top: 16px;
}
.credential-usage h3 {
  margin: 0 0 10px;
  font-size: var(--mar-font-size-title);
}
.credential-usage h4 {
  margin: 16px 0 8px;
  font-size: var(--mar-font-size-title);
}
.credential-usage-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--mar-border-subtle);
  border-radius: 6px;
  overflow: hidden;
}
.credential-usage-metric {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px;
}
.credential-usage-metric + .credential-usage-metric {
  border-left: 1px solid var(--mar-border-subtle);
}
.credential-usage-metric span,
.credential-usage-date {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.credential-usage-metric strong {
  overflow: hidden;
  font-size: var(--mar-font-size-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.credential-usage-date {
  overflow-wrap: anywhere;
}
.credential-usage-window {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 16px;
}
.credential-usage-window span {
  color: var(--mar-text-secondary);
}
.model-enabled {
  padding-block: 4px;
  border-block: 1px solid var(--mar-border-subtle);
}
.order-handle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding-inline: 6px;
  border-radius: 4px;
  color: var(--mar-text-secondary);
  cursor: grab;
  user-select: none;
}
.order-handle:hover {
  background: var(--mar-fill-hover);
  color: var(--mar-text-primary);
}
.order-handle.is-dragging {
  opacity: 0.45;
  cursor: grabbing;
}
@media (max-width: 700px) {
  .model-grid {
    grid-template-columns: 1fr;
  }
  .credential-usage-summary {
    grid-template-columns: 1fr;
  }
  .credential-usage-metric + .credential-usage-metric {
    border-top: 1px solid var(--mar-border-subtle);
    border-left: 0;
  }
  .dialog-footer-summary {
    float: none;
    display: block;
    padding-top: 0;
  }
}
</style>
