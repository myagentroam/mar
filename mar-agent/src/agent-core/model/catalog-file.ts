import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MarAgentError } from '../error.js';
import {
  parseModelCatalog,
  type MarAgentModelConfiguration,
  type ModelCatalog
} from './configuration.js';

export type CliModelCredentialSource = 'CODEX_AUTH_FILE';

export interface CliModelConfiguration extends MarAgentModelConfiguration {
  credentialSource?: CliModelCredentialSource;
}

export interface CliModelCatalog extends Omit<ModelCatalog, 'models'> {
  models: readonly CliModelConfiguration[];
}

export const modelCatalogPath = (home: string) => join(home, '.mar', 'agent', 'models.json');

export async function readModelCatalog(home: string): Promise<CliModelCatalog> {
  try {
    return parseCliModelCatalog(JSON.parse(await readFile(modelCatalogPath(home), 'utf8')), {
      allowLoopbackHttp: true
    });
  } catch (cause) {
    if (cause instanceof MarAgentError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, models: [] };
    throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Model catalog cannot be read.', {
      cause
    });
  }
}

export async function writeModelCatalog(home: string, catalog: CliModelCatalog): Promise<void> {
  const path = modelCatalogPath(home);
  await mkdir(join(home, '.mar', 'agent'), { recursive: true });
  const raw = {
    version: 1,
    ...(catalog.defaultModelId ? { defaultModelId: catalog.defaultModelId } : {}),
    models: catalog.models.map(serializeModel)
  };
  parseCliModelCatalog(raw, { allowLoopbackHttp: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function serializeModel(model: CliModelConfiguration) {
  const { apiKey, credentialProvider, credentialSource, ...configuration } = model;
  if (apiKey !== undefined) {
    if (credentialProvider !== undefined || credentialSource !== undefined)
      throw new MarAgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Model credential sources are ambiguous.'
      );
    return { ...configuration, apiKey: apiKey.reveal() };
  }
  if (credentialSource !== undefined)
    return {
      ...configuration,
      credential: { type: credentialSource }
    };
  throw new MarAgentError(
    'MAR_AGENT_MODEL_CONFIG_INVALID',
    'Dynamic model credentials cannot be persisted without an external credential marker.'
  );
}

function parseCliModelCatalog(
  input: unknown,
  options: { allowLoopbackHttp?: boolean } = {}
): CliModelCatalog {
  if (!isRecord(input) || !Array.isArray(input.models)) return parseModelCatalog(input, options);

  const externalCredentialModels = new Set<number>();
  const normalizedModels = input.models.map((model, index) => {
    if (isRecord(model) && Object.hasOwn(model, 'highDensityCompaction')) {
      if (typeof model.highDensityCompaction !== 'boolean') throw invalidCatalog();
      const { highDensityCompaction: _compaction, ...configuration } = model;
      void _compaction;
      model = configuration;
    }
    if (isRecord(model) && Object.hasOwn(model, 'responsesEncoding')) {
      if (
        model.protocol !== 'OPENAI_RESPONSES' ||
        (model.responsesEncoding !== 'STANDARD' && model.responsesEncoding !== 'LITE')
      )
        throw invalidCatalog();
      const { responsesEncoding: _encoding, ...configuration } = model;
      void _encoding;
      model = configuration;
    }
    if (!isRecord(model) || !Object.hasOwn(model, 'credential')) return model;
    const credential = model.credential;
    if (
      !isRecord(credential) ||
      credential.type !== 'CODEX_AUTH_FILE' ||
      Object.keys(credential).length !== 1
    )
      throw invalidCatalog();
    if (Object.hasOwn(model, 'apiKey')) throw invalidCatalog();
    externalCredentialModels.add(index);
    const { credential: _credential, ...configuration } = model;
    void _credential;
    return { ...configuration, apiKey: '__MAR_AGENT_EXTERNAL_CREDENTIAL__' };
  });
  const parsed = parseModelCatalog({ ...input, models: normalizedModels }, options);
  return {
    ...parsed,
    models: parsed.models.map((model, index) => {
      if (!externalCredentialModels.has(index)) return model;
      if (model.protocol !== 'OPENAI_RESPONSES') throw invalidCatalog();
      const { apiKey: _apiKey, ...configuration } = model;
      void _apiKey;
      return { ...configuration, credentialSource: 'CODEX_AUTH_FILE' };
    })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidCatalog(): MarAgentError {
  return new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Model catalog is invalid.');
}
