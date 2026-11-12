import { obfuscateVncPassword } from './vnc-password.js';

/** Writes the Win32 profile representation of UltraVNC's eight-byte password. */
export function ultraVncProfilePassword(password: Uint8Array): string {
  const encoded = obfuscateVncPassword(password);
  try {
    const checksum = encoded.reduce((sum, byte) => (sum + byte) & 255, 0);
    return Buffer.concat([encoded, Buffer.from([checksum])]).toString('hex');
  } finally {
    encoded.fill(0);
  }
}

/** Configures an authenticated local-only RFB server without file transfer. */
export function ultraVncConfig(port: number, password: Uint8Array): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('DESKTOP_BACKEND_CONFIG_INVALID');
  return [
    '[admin]',
    'LoopbackOnly=1',
    'AllowLoopback=1',
    'AuthRequired=1',
    'SocketConnect=1',
    'HTTPConnect=0',
    'UseIpv6=0',
    'AutoPortSelect=0',
    `PortNumber=${port}`,
    'InputsEnabled=1',
    'QuerySetting=0',
    'FileTransferEnabled=0',
    'secondary=1',
    '[UltraVNC]',
    `passwd=${ultraVncProfilePassword(password)}`,
    ''
  ].join('\r\n');
}
