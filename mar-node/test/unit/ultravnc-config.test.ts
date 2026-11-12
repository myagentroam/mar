import { expect, it } from 'vitest';
import {
  ultraVncConfig,
  ultraVncProfilePassword
} from '../../src/remote-desktop/ultravnc-config.js';

it('writes the Win32 profile password and an authenticated loopback-only configuration', () => {
  // The profile bytes were compared with WritePrivateProfileStruct on the Windows runner.
  const password = Buffer.from('testvnc1');
  expect(ultraVncProfilePassword(password)).toBe('5d3c33ea7d927e77ba');
  const config = ultraVncConfig(50030, password);
  expect(config).toContain('LoopbackOnly=1\r\n');
  expect(config).toContain('AuthRequired=1\r\n');
  expect(config).toContain('FileTransferEnabled=0\r\n');
  expect(config).toContain('[UltraVNC]\r\npasswd=5d3c33ea7d927e77ba\r\n');
  expect(config).not.toContain('testvnc1');
  expect(() => ultraVncConfig(0, password)).toThrow('DESKTOP_BACKEND_CONFIG_INVALID');
});
