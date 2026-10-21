import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function browserCachePath(dataDirectory: string): string {
  const configured = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  return configured === '0' ? '0' : resolve(configured ?? resolve(dataDirectory, 'web-browsers'));
}

export function systemdUnit(
  executable: string,
  configPath: string,
  entrypoint?: string,
  writablePaths: readonly string[] = [],
  browserPath?: string
): string {
  const command = [
    escapeSystemd(executable),
    ...(entrypoint === undefined ? [] : [escapeSystemd(entrypoint)])
  ].join(' ');
  const readWritePaths = [
    ...writablePaths,
    ...(browserPath === undefined || browserPath === '0' ? [] : [browserPath])
  ]
    .map((path) => escapeSystemd(resolve(path)))
    .join(' ');
  return `[Unit]\nDescription=MyAgentRoam Node\nAfter=network-online.target\n\n[Service]\nType=simple\nUser=mar-node\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\n${readWritePaths.length === 0 ? '' : `ReadWritePaths=${readWritePaths}\n`}${browserPath === undefined ? '' : `Environment=${escapeSystemd(`PLAYWRIGHT_BROWSERS_PATH=${browserPath}`)}\n`}ExecStart=${command} supervise --config ${escapeSystemd(configPath)}\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function windowsServiceDefinition(
  executable: string,
  configPath: string,
  entrypoint?: string,
  browserPath?: string
): string {
  return JSON.stringify(
    {
      serviceName: 'MyAgentRoamNode',
      displayName: 'MyAgentRoam Node',
      binaryPath: `"${executable}"${entrypoint === undefined ? '' : ` "${entrypoint}"`} supervise --config "${configPath}"${browserPath === undefined ? '' : ` --browser-cache "${browserPath}"`}`,
      startType: 'auto',
      account: 'LocalService'
    },
    undefined,
    2
  );
}

export function launchdServiceDefinition(
  executable: string,
  configPath: string,
  entrypoint?: string,
  browserPath?: string
): string {
  const argumentsList = [
    executable,
    ...(entrypoint === undefined ? [] : [entrypoint]),
    'supervise',
    '--config',
    configPath
  ]
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.myagentroam.node</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
${browserPath === undefined ? '' : `    <key>PLAYWRIGHT_BROWSERS_PATH</key>\n    <string>${escapeXml(browserPath)}</string>`}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

export async function writeServiceDefinition(
  outputPath: string,
  executable: string,
  configPath: string,
  platform: NodeJS.Platform = process.platform,
  entrypoint?: string,
  writablePaths: readonly string[] = [],
  browserPath?: string
): Promise<void> {
  const contents =
    platform === 'linux'
      ? systemdUnit(executable, configPath, entrypoint, writablePaths, browserPath)
      : platform === 'win32'
        ? windowsServiceDefinition(executable, configPath, entrypoint, browserPath)
        : platform === 'darwin'
          ? launchdServiceDefinition(executable, configPath, entrypoint, browserPath)
          : (() => {
              throw new Error('NODE_PLATFORM_UNSUPPORTED');
            })();
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o755 });
  await writeFile(outputPath, contents, { mode: 0o644 });
  if (platform !== 'win32') await chmod(outputPath, 0o644);
}

export async function removeServiceDefinition(outputPath: string): Promise<void> {
  await rm(resolve(outputPath), { force: true });
}

function escapeSystemd(value: string): string {
  return JSON.stringify(value);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/gu, (character) => {
    switch (character) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return character;
    }
  });
}
