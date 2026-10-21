interface WebVersionUpdateServiceOptions {
  readonly currentVersion: string;
  readonly currentHash: string;
  readonly fetchVersion: () => Promise<unknown>;
  readonly onUpdateAvailable: (version: string, hash: string) => void;
  readonly onVersionCurrent?: () => void;
}

interface WebVersionManifest {
  readonly version: string;
  readonly hash: string;
}

export function createWebVersionUpdateService(options: WebVersionUpdateServiceOptions) {
  let checking: Promise<void> | undefined;

  async function check(): Promise<void> {
    if (checking !== undefined) return checking;
    checking = checkOnce();
    try {
      await checking;
    } finally {
      checking = undefined;
    }
  }

  async function checkOnce(): Promise<void> {
    const latest = manifestFrom(await options.fetchVersion());
    if (latest === undefined) return;
    if (latest.version === options.currentVersion && latest.hash === options.currentHash) {
      options.onVersionCurrent?.();
      return;
    }
    options.onUpdateAvailable(latest.version, latest.hash);
  }

  return { check };
}

function manifestFrom(value: unknown): WebVersionManifest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const version = (value as Partial<WebVersionManifest>).version;
  const hash = (value as Partial<WebVersionManifest>).hash;
  return typeof version === 'string' &&
    version.length > 0 &&
    typeof hash === 'string' &&
    hash.length > 0
    ? { version, hash }
    : undefined;
}
