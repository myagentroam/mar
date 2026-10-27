import { AgentError } from '../error.js';

export class SecretValue {
  #value: string;

  constructor(value: string) {
    if (value.length === 0)
      throw new AgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'API key is required.');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }
}

export type ModelCredentialAcquireReason = 'REQUEST' | 'UNAUTHORIZED' | 'RECONNECT';

export interface ModelCredential {
  readonly revision: number;
  readonly expiresAt: number;
  readonly bearer: SecretValue;
  readonly headers: Readonly<Record<string, SecretValue | string>>;
  readonly socks5Url?: SecretValue;
}

export interface ModelCredentialProvider {
  acquire(reason: ModelCredentialAcquireReason): Promise<ModelCredential>;
  invalidate(revision: number): void | Promise<void>;
  close(): Promise<void>;
}
