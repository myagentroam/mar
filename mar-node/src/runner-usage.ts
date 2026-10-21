import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunnerName } from '@myagentroam/protocol';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_MAX_BYTES = 256 * 1024;
const RESPONSE_MAX_BYTES = 256 * 1024;
const CODEX_CACHE_MS = 60_000;
const CLAUDE_CACHE_MS = 5 * 60_000;

export const USAGE_OAUTH_REQUIRED = 'OFFICIAL_OAUTH_REQUIRED';

interface RunnerUsageStatus {
  readonly runner: RunnerName;
  readonly available: boolean;
  readonly reasonCode: string | null;
}

interface RunnerUsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercentage: number;
  readonly resetsAt: number | null;
}

interface RunnerUsage {
  readonly runner: RunnerName;
  readonly windows: readonly RunnerUsageWindow[];
  readonly fetchedAt: number;
  readonly cached: boolean;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface UsageCredentials {
  readonly accessToken: string;
  readonly accountId?: string;
}

export class RunnerUsageReader {
  private readonly cache = new Map<RunnerName, RunnerUsage>();

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly homePath = homedir(),
    private readonly now: () => number = Date.now
  ) {}

  async status(runner: RunnerName): Promise<RunnerUsageStatus> {
    return (await this.credentials(runner)) === undefined
      ? unavailable(runner, USAGE_OAUTH_REQUIRED)
      : { runner, available: true, reasonCode: null };
  }

  async read(runner: RunnerName): Promise<RunnerUsage> {
    const status = await this.status(runner);
    if (!status.available) throw new Error(status.reasonCode ?? 'USAGE_UNAVAILABLE');
    const cached = this.cache.get(runner);
    const now = this.now();
    if (cached !== undefined && now - cached.fetchedAt < cacheDuration(runner)) {
      return { ...cached, cached: true };
    }
    const credentials = await this.credentials(runner);
    if (credentials === undefined) throw new Error(USAGE_OAUTH_REQUIRED);
    const usage =
      runner === 'codex'
        ? await this.readCodex(credentials, now)
        : await this.readClaude(credentials, now);
    this.cache.set(runner, usage);
    return usage;
  }

  private async credentials(runner: RunnerName): Promise<UsageCredentials | undefined> {
    const path =
      runner === 'codex'
        ? join(this.homePath, '.codex', 'auth.json')
        : join(this.homePath, '.claude', '.credentials.json');
    const value = await readJson(path);
    return runner === 'codex' ? codexCredentials(value) : claudeCredentials(value);
  }

  private async readCodex(credentials: UsageCredentials, fetchedAt: number): Promise<RunnerUsage> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`
    };
    if (credentials.accountId !== undefined) headers['ChatGPT-Account-Id'] = credentials.accountId;
    const value = await requestJson(this.fetcher, CODEX_USAGE_URL, headers);
    const windows = [
      codexUsageWindow(value, 'primary_window'),
      codexUsageWindow(value, 'secondary_window')
    ].filter((window): window is RunnerUsageWindow => window !== undefined);
    if (windows.length === 0) throw new Error('USAGE_RESPONSE_INVALID');
    return { runner: 'codex', windows, fetchedAt, cached: false };
  }

  private async readClaude(credentials: UsageCredentials, fetchedAt: number): Promise<RunnerUsage> {
    const value = await requestJson(this.fetcher, CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json'
    });
    const windows = [
      usageWindow(value, 'five_hour', '5-hour limit'),
      usageWindow(value, 'seven_day', '7-day limit'),
      usageWindow(value, 'seven_day_sonnet', '7-day Sonnet limit')
    ].filter((window): window is RunnerUsageWindow => window !== undefined);
    if (windows.length === 0) throw new Error('USAGE_RESPONSE_INVALID');
    return { runner: 'claude-code', windows, fetchedAt, cached: false };
  }
}

function unavailable(runner: RunnerName, reasonCode: string): RunnerUsageStatus {
  return { runner, available: false, reasonCode };
}

function cacheDuration(runner: RunnerName): number {
  return runner === 'codex' ? CODEX_CACHE_MS : CLAUDE_CACHE_MS;
}

async function readJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > CREDENTIALS_MAX_BYTES) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function codexCredentials(value: unknown): UsageCredentials | undefined {
  const root = record(value);
  const tokens = record(root?.tokens) ?? root;
  const accessToken = string(tokens?.access_token) ?? string(tokens?.accessToken);
  if (accessToken === undefined) return undefined;
  const accountId =
    string(tokens?.account_id) ?? string(tokens?.accountId) ?? string(root?.account_id);
  return { accessToken, ...(accountId === undefined ? {} : { accountId }) };
}

function claudeCredentials(value: unknown): UsageCredentials | undefined {
  const credentials = record(record(value)?.claudeAiOauth);
  const accessToken = string(credentials?.accessToken);
  return accessToken === undefined ? undefined : { accessToken };
}

async function requestJson(
  fetcher: FetchLike,
  url: string,
  headers: Record<string, string>
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403)
      throw new Error('USAGE_AUTHENTICATION_FAILED');
    if (response.status === 429) throw new Error('USAGE_RATE_LIMITED');
    if (!response.ok) throw new Error('USAGE_REQUEST_FAILED');
    const text = await response.text();
    if (text.length > RESPONSE_MAX_BYTES) throw new Error('USAGE_RESPONSE_INVALID');
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('USAGE_REQUEST_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function usageWindow(value: unknown, key: string, label: string): RunnerUsageWindow | undefined {
  const window = record(record(value)?.rate_limit)?.[key] ?? record(value)?.[key];
  const source = record(window);
  const usedPercentage =
    number(source?.utilization) ?? number(source?.used_percentage) ?? number(source?.used_percent);
  if (usedPercentage === undefined || usedPercentage < 0 || usedPercentage > 100) return undefined;
  const resetsAt = timestamp(source?.resets_at) ?? timestamp(source?.reset_at);
  return { id: key, label, usedPercentage, resetsAt };
}

/**
 * Codex backend window names are roles, not durations: depending on a plan,
 * `primary_window` may itself be the weekly quota. Community clients classify
 * them using the response's `limit_window_seconds`, never their position.
 */
function codexUsageWindow(value: unknown, key: string): RunnerUsageWindow | undefined {
  const window = record(record(value)?.rate_limit)?.[key];
  const duration = number(record(window)?.limit_window_seconds);
  const label =
    duration !== undefined && approximately(duration, 5 * 60 * 60)
      ? '5-hour limit'
      : duration !== undefined && approximately(duration, 7 * 24 * 60 * 60)
        ? '7-day limit'
        : undefined;
  return label === undefined ? undefined : usageWindow(value, key, label);
}

function approximately(value: number, expected: number): boolean {
  return Math.abs(value - expected) / expected <= 0.1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 20_000
    ? value
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return Math.floor(value < 10_000_000_000 ? value * 1_000 : value);
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
