import path from 'node:path';
import { MarctlError } from './errors.mjs';

export function parseScpEndpoint(value) {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new MarctlError('Invalid copy endpoint.');
  const explicit = value.indexOf('://');
  const separator = explicit >= 0 ? explicit : value.indexOf(':');
  if (separator < 0 || (separator === 1 && /^[A-Za-z]:[\\/]/u.test(value))) {
    // Let the filesystem resolve dot components and symlink parents.
    return { path: path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}` };
  }
  const host = value.slice(0, separator);
  const file = value.slice(separator + (explicit >= 0 ? 3 : 1));
  if (!host || !file || (!file.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(file)))
    throw new MarctlError('Invalid Node file path.');
  return { host, path: file };
}

export function scpSourceBasename(value) {
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
  if (value.endsWith('/') || (windowsPath && value.endsWith('\\')))
    throw new MarctlError('Invalid source filename.');
  const sourcePath = windowsPath ? path.win32 : path.posix;
  const basename = sourcePath.basename(value);
  if (!basename || basename === '.' || basename === '..')
    throw new MarctlError('Invalid source filename.');
  return basename;
}
