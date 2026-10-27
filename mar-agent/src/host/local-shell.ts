import { randomUUID } from 'node:crypto';
import { basename, win32 } from 'node:path';
import type { LocalProcessSpawnRequest } from '../process/contracts.js';

/** Resolve Shell startup in the executor, after its environment policy has been applied. */
export function prepareLocalShellProcess(
  request: LocalProcessSpawnRequest,
  platform: NodeJS.Platform = process.platform
): LocalProcessSpawnRequest {
  if (!request.shell || request.shellLogin === undefined) return request;
  const shell =
    typeof request.shell === 'string'
      ? request.shell
      : platform === 'win32'
        ? (request.environment.ComSpec ?? request.environment.COMSPEC ?? 'cmd.exe')
        : '/bin/sh';
  const name = (platform === 'win32' ? win32.basename(shell) : basename(shell))
    .replace(/\.exe$/iu, '')
    .toLowerCase();
  const powershell = name === 'pwsh' || name === 'powershell';
  if (!powershell && !['bash', 'zsh', 'sh'].includes(name)) return request;

  const login = request.shellLogin;
  const environment = { ...request.environment };
  const script: string[] = [];
  if (login && name === 'bash') {
    script.push(
      'if [ -z "${BASH_ENV-}" ] && [ -n "${HOME-}" ] && [ -r "$HOME/.bashrc" ]; then',
      '  . "$HOME/.bashrc"',
      'fi'
    );
  } else if (login && name === 'zsh') {
    script.push(
      'if [[ -n "${ZDOTDIR-}" ]]; then',
      '  [[ ! -r "$ZDOTDIR/.zshrc" ]] || . "$ZDOTDIR/.zshrc"',
      'elif [[ -n "${HOME-}" ]]; then',
      '  [[ ! -r "$HOME/.zshrc" ]] || . "$HOME/.zshrc"',
      'fi'
    );
  }

  // Keep values out of argv and tool-visible command history, including quoting-sensitive values.
  const privatePrefix = `__MAR_SHELL_${randomUUID().replaceAll('-', '')}_`;
  const restoration: string[] = [];
  let index = 0;
  for (const [key, value] of Object.entries(request.environmentOverrides ?? {})) {
    if (!powershell && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    const quotedKey = `'${key.replaceAll("'", "''")}'`;
    if (value === undefined) {
      restoration.push(
        powershell
          ? `[Environment]::SetEnvironmentVariable(${quotedKey}, $null, 'Process')`
          : `if [ "\${${key}+x}" = x ]; then unset ${key} || exit; fi`
      );
      continue;
    }
    const privateKey = `${privatePrefix}${index++}`;
    environment[privateKey] = value;
    restoration.push(
      powershell
        ? `if (-not (Test-Path Env:${privateKey})) { throw 'Shell startup removed a protected environment value.' }`
        : `[ "\${${privateKey}+x}" = x ] || { printf '%s\\n' 'Shell startup removed a protected environment value.' >&2; exit 1; }`
    );
    restoration.push(
      powershell
        ? `[Environment]::SetEnvironmentVariable(${quotedKey}, $env:${privateKey}, 'Process'); Remove-Item Env:${privateKey}`
        : `if [ "\${${key}+x}" != x ] || [ "\${${key}-}" != "$${privateKey}" ]; then export ${key}="$${privateKey}" || exit; else export ${key} || exit; fi; unset ${privateKey}`
    );
  }
  if (restoration.length && !powershell) {
    const traceKey = `${privatePrefix}TRACE`;
    // A profile may enable xtrace; do not print expanded private values during restoration.
    script.push(
      `case $- in *x*) set +x; ${traceKey}=1 ;; *) ${traceKey}= ;; esac`,
      ...restoration,
      `if [ "$${traceKey}" = 1 ]; then unset ${traceKey}; set -x; else unset ${traceKey}; fi`
    );
  } else {
    script.push(...restoration);
  }
  script.push(request.command);
  return {
    ...request,
    command: shell,
    args: [
      ...(powershell ? [...(login ? [] : ['-NoProfile']), '-Command'] : [login ? '-lc' : '-c']),
      script.join('\n'),
      ...(request.args ?? [])
    ],
    shell: false,
    environment,
    ...(request.environmentKeys === undefined
      ? {}
      : {
          environmentKeys: [
            ...request.environmentKeys,
            ...Object.keys(environment).filter((key) => key.startsWith(privatePrefix))
          ]
        })
  };
}
