import { createHash } from 'node:crypto';
import {
  codexModelCatalogSchema,
  resolveMarAgentDefaultReasoningEffort,
  type CodexModelCatalog
} from '@myagentroam/protocol';
import {
  asOptionalRecord,
  optionalString,
  parsePositiveInteger
} from './credential-provider-values.js';

const SUPPORTED_REASONING = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function normalizeChatgptCatalog(raw: unknown, fetchedAt: number): CodexModelCatalog {
  const payload = asOptionalRecord(raw);
  if (!payload || !Array.isArray(payload['models']) || payload['models'].length > 1000)
    throw new Error('CODEX_CATALOG_LOAD_FAILED');
  const models = payload['models'].flatMap((item) => {
    const model = asOptionalRecord(item);
    if (!model) return [];
    return [{ ...model, supported_in_api: model['supported_in_api'] ?? true }];
  });
  return normalizeCatalog({ models }, fetchedAt);
}

export function normalizeCatalog(raw: unknown, fetchedAt: number): CodexModelCatalog {
  const value = asOptionalRecord(raw);
  if (value === undefined || !Array.isArray(value['models']))
    throw new Error('CODEX_CATALOG_LOAD_FAILED');
  const models = value['models'];
  const candidates = models.flatMap((rawModel) => {
    const model = asOptionalRecord(rawModel);
    if (model === undefined || model['visibility'] !== 'list' || model['supported_in_api'] !== true)
      return [];
    const upstreamModelId = optionalString(model['slug'], 256);
    const displayName = optionalString(model['display_name'], 256);
    if (upstreamModelId === undefined || displayName === undefined) return [];
    const reasoning = Array.isArray(model['supported_reasoning_levels'])
      ? model['supported_reasoning_levels']
          .map((entry) => optionalString(asOptionalRecord(entry)?.['effort'], 128))
          .filter((entry): entry is string => entry !== undefined)
      : [];
    const reasoningEfforts = unique(reasoning.filter((effort) => SUPPORTED_REASONING.has(effort)));
    const unsupportedReasoningEfforts = unique(
      reasoning.filter((effort) => !SUPPORTED_REASONING.has(effort))
    );
    const upstreamDefaultReasoningEffort = optionalString(model['default_reasoning_level'], 128);
    const defaultReasoningEffort = resolveMarAgentDefaultReasoningEffort(
      upstreamDefaultReasoningEffort,
      reasoningEfforts
    );
    const modalities = Array.isArray(model['input_modalities'])
      ? model['input_modalities']
      : ['text'];
    const inputCapabilities = unique(
      modalities.flatMap((modality) =>
        modality === 'text' ? ['TEXT' as const] : modality === 'image' ? ['IMAGE' as const] : []
      )
    );
    if (!inputCapabilities.includes('TEXT')) inputCapabilities.unshift('TEXT');
    const contextWindowTokens =
      parsePositiveInteger(model['context_window'], Number.MAX_SAFE_INTEGER) ??
      parsePositiveInteger(model['max_context_window'], Number.MAX_SAFE_INTEGER);
    const maxOutputTokens = parsePositiveInteger(
      model['max_output_tokens'],
      Number.MAX_SAFE_INTEGER
    );
    const requiredInputs =
      contextWindowTokens === undefined ? (['contextWindowTokens'] as const) : [];
    const warnings = unsupportedReasoningEfforts.map(
      (effort) => `Unsupported reasoning effort: ${effort}`
    );
    if (
      upstreamDefaultReasoningEffort !== undefined &&
      upstreamDefaultReasoningEffort !== defaultReasoningEffort
    )
      warnings.push(`Unsupported default reasoning effort: ${upstreamDefaultReasoningEffort}`);
    return [
      {
        upstreamModelId,
        displayName,
        ...(optionalString(model['description'], 4096) === undefined
          ? {}
          : { description: optionalString(model['description'], 4096) }),
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        reasoningEfforts,
        defaultReasoningEffort,
        unsupportedReasoningEfforts,
        inputCapabilities,
        hostedWebSearch:
          model['supports_search_tool'] === true ||
          (typeof model['web_search_tool_type'] === 'string' &&
            model['web_search_tool_type'] !== 'disabled'),
        warnings,
        requiredInputs
      }
    ];
  });
  const canonical = JSON.stringify(candidates);
  const parsed = codexModelCatalogSchema.safeParse({
    catalogHash: createHash('sha256').update(canonical).digest('hex'),
    fetchedAt,
    models: candidates
  });
  if (!parsed.success) throw new Error('CODEX_CATALOG_LOAD_FAILED');
  return parsed.data;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
