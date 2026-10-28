import { join } from 'node:path';

function runnerEnvironmentOverrides(home: string): Record<string, string | undefined> {
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    CODEX_HOME: join(home, '.codex'),
    CODEX_CONFIG_DIR: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_HOME: join(home, '.claude'),
    OPENCODE_CONFIG: undefined,
    OPENCODE_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    ANTHROPIC_BASE_URL: undefined,
    MAR_NODE_CONFIG: join(home, 'node.json'),
    MAR_NODE_SUPERVISED: undefined
  };
}

/** Construct a child fixture environment without inheriting Runner configuration or credentials. */
export function isolatedRunnerEnvironment(
  home: string,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const [key, value] of Object.entries(runnerEnvironmentOverrides(home))) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

/** Isolate in-process Node fixtures before constructing their Connector. */
export function isolateRunnerEnvironment(home: string): () => void {
  const values = runnerEnvironmentOverrides(home);
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
