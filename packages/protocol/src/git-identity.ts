import { z } from 'zod';

const cleanLine = z
  .string()
  .trim()
  .max(256)
  // eslint-disable-next-line no-control-regex -- Git fields must reject control characters.
  .refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
export const personalGitIdentitySchema = z
  .object({
    name: cleanLine.refine((value) => !/[<>]/u.test(value)),
    email: cleanLine.refine((value) => value === '' || /^[^\s<>@]+@[^\s<>@]+$/u.test(value))
  })
  .strict()
  .refine((value) => Boolean(value.name) === Boolean(value.email));
export type PersonalGitIdentity = z.infer<typeof personalGitIdentitySchema>;

export function normalizeGitHost(value: string): string {
  const host = value.toLowerCase();
  if (!host || /[\s/@\\?#*%]/u.test(host) || host.startsWith('-'))
    throw new Error('GIT_CONFIGURATION_INVALID');
  const parsed = new URL(`https://${host}`);
  if (parsed.port || parsed.username || parsed.password || parsed.hostname !== host)
    throw new Error('GIT_CONFIGURATION_INVALID');
  return host;
}

export function normalizeGitPath(value: string): string {
  const path = value.replace(/^\/+|\/+$/gu, '');
  if (
    // eslint-disable-next-line no-control-regex -- Reject control characters in repository scopes.
    /[\x00-\x1f\x7f\\]/u.test(path) ||
    (path !== '' && path.split('/').some((part) => part === '' || part === '.' || part === '..'))
  )
    throw new Error('GIT_CONFIGURATION_INVALID');
  return path;
}

export interface GitRemoteUrl {
  readonly protocol: 'HTTPS' | 'SSH';
  readonly host: string;
  readonly port: number;
  readonly pathPrefix: string;
  /** SSH remote login; HTTPS authentication continues to use the credential username. */
  readonly username?: string;
}

/** Parses the complete HTTPS or SSH remote address accepted by the management form. */
export function parseGitRemoteUrl(value: string): GitRemoteUrl {
  const remote = value.trim();
  if (remote.startsWith('https://') || remote.startsWith('ssh://')) {
    let address: URL;
    try {
      address = new URL(remote);
    } catch {
      throw new Error('GIT_CONFIGURATION_INVALID');
    }
    if (address.search || address.hash || address.password)
      throw new Error('GIT_CONFIGURATION_INVALID');
    const protocol = address.protocol === 'https:' ? 'HTTPS' : 'SSH';
    if (address.protocol !== 'https:' && address.protocol !== 'ssh:')
      throw new Error('GIT_CONFIGURATION_INVALID');
    const pathPrefix = normalizeGitPath(decodeURIComponent(address.pathname));
    if (protocol === 'HTTPS') {
      if (!pathPrefix) throw new Error('GIT_CONFIGURATION_INVALID');
      if (address.username) throw new Error('GIT_CONFIGURATION_INVALID');
      return {
        protocol,
        host: normalizeGitHost(address.hostname),
        port: Number(address.port || 443),
        pathPrefix
      };
    }
    const username = decodeURIComponent(address.username);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/u.test(username))
      throw new Error('GIT_CONFIGURATION_INVALID');
    return {
      protocol,
      host: normalizeGitHost(address.hostname),
      port: Number(address.port || 22),
      pathPrefix,
      username
    };
  }
  const scp = /^([A-Za-z0-9_][A-Za-z0-9_.@-]*)@([^:/\s]+)(?::(.+))?$/u.exec(remote);
  if (scp === null) throw new Error('GIT_CONFIGURATION_INVALID');
  const pathPrefix = scp[3] === undefined ? '' : normalizeGitPath(scp[3]);
  if (scp[3] !== undefined && !pathPrefix) throw new Error('GIT_CONFIGURATION_INVALID');
  return {
    protocol: 'SSH',
    host: normalizeGitHost(scp[2]!),
    port: 22,
    pathPrefix,
    username: scp[1]!
  };
}

/** Formats a canonical complete remote address without exposing secrets. */
export function formatGitRemoteUrl(
  credential: Pick<GitCredential, 'protocol' | 'host' | 'port' | 'pathPrefix' | 'username'>
): string {
  const path = credential.pathPrefix ? `/${credential.pathPrefix}` : '';
  if (credential.protocol === 'HTTPS')
    return `https://${credential.host}${credential.port === 443 ? '' : `:${credential.port}`}${path}`;
  if (credential.port === 22)
    return `${credential.username}@${credential.host}${credential.pathPrefix ? `:${credential.pathPrefix}` : ''}`;
  return `ssh://${credential.username}@${credential.host}:${credential.port}${path}`;
}

const hostSchema = cleanLine
  .refine((value) => value.length > 0)
  .transform((value, context) => {
    try {
      return normalizeGitHost(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Enter a host without a protocol, port or path.'
      });
      return z.NEVER;
    }
  });
const pathSchema = z
  .string()
  .trim()
  .max(2048)
  .transform((value, context) => {
    try {
      return normalizeGitPath(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Enter a repository path without traversal or empty segments.'
      });
      return z.NEVER;
    }
  });
const secretSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'));
const passphraseSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value));
const credentialFields = {
  name: cleanLine.refine((value) => value.length > 0),
  protocol: z.enum(['HTTPS', 'SSH']),
  host: hostSchema,
  port: z.number().int().min(1).max(65_535),
  pathPrefix: pathSchema,
  username: cleanLine.refine((value) => value.length > 0),
  commitName: cleanLine.refine((value) => !/[<>]/u.test(value)),
  commitEmail: cleanLine.refine((value) => value === '' || /^[^\s<>@]+@[^\s<>@]+$/u.test(value))
};
function credentialIssues(
  value: {
    protocol: 'HTTPS' | 'SSH';
    username: string;
    commitName?: string | undefined;
    commitEmail?: string | undefined;
    secret?: string | undefined;
    passphrase?: string | null | undefined;
  },
  context: z.RefinementCtx
): void {
  if (value.protocol === 'HTTPS') {
    if (value.passphrase !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['passphrase'],
        message: 'HTTPS credentials cannot include an SSH passphrase.'
      });
    if (value.secret !== undefined && /[\r\n]/u.test(value.secret))
      context.addIssue({
        code: 'custom',
        path: ['secret'],
        message: 'Enter a single-line HTTPS password.'
      });
  }
  if (value.protocol === 'SSH') {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/u.test(value.username))
      context.addIssue({
        code: 'custom',
        path: ['username'],
        message: 'Enter a valid SSH username.'
      });
    if (
      value.secret !== undefined &&
      !/^-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----\r?\n/u.test(value.secret)
    )
      context.addIssue({
        code: 'custom',
        path: ['secret'],
        message: 'Enter a PEM or OpenSSH private key.'
      });
  }
  if (
    value.commitName !== undefined &&
    value.commitEmail !== undefined &&
    Boolean(value.commitName) !== Boolean(value.commitEmail)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['commitName'],
      message: 'Set or clear the commit name and email together.'
    });
    context.addIssue({
      code: 'custom',
      path: ['commitEmail'],
      message: 'Set or clear the commit name and email together.'
    });
  }
}
export const gitCredentialInputSchema = z
  .object({
    ...credentialFields,
    secret: secretSchema,
    passphrase: passphraseSchema.optional()
  })
  .strict()
  .superRefine(credentialIssues);
export const gitCredentialUpdateSchema = z
  .object({
    ...credentialFields,
    secret: secretSchema.optional(),
    passphrase: passphraseSchema.nullable().optional()
  })
  .strict()
  .superRefine(credentialIssues);
export const gitCredentialSchema = z
  .object({
    ...credentialFields,
    id: z.string().min(1).max(128),
    secret: secretSchema,
    passphrase: passphraseSchema.optional()
  })
  .strict()
  .superRefine(credentialIssues);
export type GitCredential = z.infer<typeof gitCredentialSchema>;
export type GitCredentialInput = z.infer<typeof gitCredentialInputSchema>;
export type GitCredentialUpdate = z.infer<typeof gitCredentialUpdateSchema>;
export const gitCredentialSummarySchema = z
  .object({
    ...credentialFields,
    id: z.string().min(1).max(128),
    hasSecret: z.boolean(),
    hasPassphrase: z.boolean()
  })
  .strict()
  .superRefine(credentialIssues);
export type GitCredentialSummary = z.infer<typeof gitCredentialSummarySchema>;

export const personalGitRuntimeSchema = z
  .object({
    credentials: z.array(gitCredentialSchema).max(64)
  })
  .strict()
  .superRefine((value, context) => {
    const scopes = value.credentials.map(gitCredentialScopeKey);
    if (
      new Set(scopes).size !== scopes.length ||
      new Set(value.credentials.map((entry) => entry.id)).size !== value.credentials.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Credential IDs and matching scopes must be unique.'
      });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024)
      context.addIssue({ code: 'custom', message: 'Git configuration exceeds the size limit.' });
  });
export type PersonalGitRuntime = z.infer<typeof personalGitRuntimeSchema>;
export const personalGitSummarySchema = z
  .object({
    credentials: z.array(gitCredentialSummarySchema).max(64)
  })
  .strict();
export type PersonalGitSummary = z.infer<typeof personalGitSummarySchema>;
export const workspaceGitSettingsSchema = z
  .object({
    preserveGitConfig: z.boolean(),
    includeParentRepository: z.boolean().optional()
  })
  .strict();

/** Reject unsupported persisted Git configuration shapes at the owning boundary. */
export function parsePersonalGitRuntime(value: unknown): PersonalGitRuntime {
  const current = personalGitRuntimeSchema.safeParse(value);
  if (current.success) return current.data;
  throw new Error('GIT_CONFIGURATION_INVALID');
}

export function gitCredentialScopeKey(
  credential: Pick<GitCredential, 'protocol' | 'host' | 'port' | 'pathPrefix'>
): string {
  return JSON.stringify([
    credential.protocol,
    credential.host,
    credential.port,
    credential.pathPrefix
  ]);
}

export interface GitCredentialTarget {
  readonly protocol: 'HTTPS' | 'SSH';
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

export function selectGitCredential<
  T extends Pick<GitCredential, 'protocol' | 'host' | 'port' | 'pathPrefix'>
>(credentials: readonly T[], target: GitCredentialTarget): T | undefined {
  let host: string;
  let path: string;
  try {
    host = normalizeGitHost(target.host);
    path = normalizeGitPath(target.path);
  } catch {
    return undefined;
  }
  return credentials
    .filter(
      (entry) =>
        entry.protocol === target.protocol &&
        entry.host === host &&
        entry.port === target.port &&
        (entry.pathPrefix === '' || path === entry.pathPrefix)
    )
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length)[0];
}
