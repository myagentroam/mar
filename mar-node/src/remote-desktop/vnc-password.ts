import { createCipheriv } from 'node:crypto';

/** Standard VNC password-file obfuscation; the result is not a password hash. */
export function obfuscateVncPassword(password: Uint8Array): Buffer {
  if (password.length !== 8 || password.includes(0))
    throw new Error('DESKTOP_BACKEND_CONFIG_INVALID');
  const key = Buffer.from('e84ad660c4721ae0'.repeat(3), 'hex');
  try {
    const cipher = createCipheriv('des-ede3', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(password), cipher.final()]);
  } finally {
    key.fill(0);
  }
}
