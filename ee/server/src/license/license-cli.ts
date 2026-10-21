import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  computeHostFingerprint,
  createLicenseDocument,
  inspectLicenseRequestCode,
  inspectLicenseDocument,
  verifyLicenseDocument,
  type LicensePayload
} from './license-domain.js';
import { LICENSE_PUBLIC_KEY } from './public-key.js';
import { cliText } from '../cli-locale.js';

const [command, ...rawArguments] = process.argv.slice(2);
const argumentsByName = parseArguments(rawArguments);

try {
  switch (command) {
    case 'keygen':
      keygen();
      break;
    case 'fingerprint':
      console.log(computeHostFingerprint(readProductUuid()));
      break;
    case 'issue':
      console.log(createLicenseDocument(issuePayload(), privateKey()));
      break;
    case 'inspect':
      console.log(JSON.stringify(inspectLicenseDocument(documentArgument()), null, 2));
      break;
    case 'verify':
      console.log(JSON.stringify(verifyLicenseDocument(documentArgument(), publicKey()), null, 2));
      break;
    default:
      throw new Error(cliText('licenseUsage'));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function keygen(): void {
  const destination = resolve(value('output', '.env/license.env'));
  if (existsSync(destination) && !argumentsByName.has('force'))
    throw new Error('LICENSE_KEY_EXISTS');
  const pair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = pair.privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64');
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `MAR_LICENSE_PRIVATE_KEY=${encodedPrivateKey}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  console.log(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  console.error(cliText('licenseKeyWritten', { destination }));
}

function issuePayload(): LicensePayload {
  const requestCode = argumentsByName.get('request-code');
  return {
    formatVersion: 1,
    licenseId: required('license-id'),
    enterpriseName: required('enterprise-name'),
    issuedAt: timestamp(required('issued-at')),
    expiresAt: timestamp(required('expires-at')),
    hostFingerprint:
      requestCode === undefined
        ? required('host-fingerprint')
        : inspectLicenseRequestCode(requestCode).hostFingerprint,
    features: ['ENTERPRISE']
  };
}

function privateKey(): KeyObject {
  const encoded = process.env['MAR_LICENSE_PRIVATE_KEY'] ?? readLicenseEnvironment();
  if (!encoded) throw new Error('MAR_LICENSE_PRIVATE_KEY_REQUIRED');
  return createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
}

function publicKey(): string {
  return process.env['MAR_LICENSE_PUBLIC_KEY'] ?? LICENSE_PUBLIC_KEY;
}

function readLicenseEnvironment(): string | undefined {
  const path = resolve(value('key-env', '.env/license.env'));
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .find((line) => line.startsWith('MAR_LICENSE_PRIVATE_KEY='))
    ?.slice('MAR_LICENSE_PRIVATE_KEY='.length);
}

function readProductUuid(): string {
  const direct = argumentsByName.get('uuid');
  if (direct) return direct;
  return readFileSync(value('path', '/license-host/product_uuid'), 'utf8');
}

function documentArgument(): string {
  const direct = argumentsByName.get('document');
  if (direct) return direct;
  const path = argumentsByName.get('file');
  if (path) return readFileSync(path, 'utf8');
  throw new Error('LICENSE_DOCUMENT_REQUIRED');
}

function timestamp(input: string): number {
  const numeric = Number(input);
  const result = Number.isSafeInteger(numeric) ? numeric : Date.parse(input);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('LICENSE_TIME_INVALID');
  return result;
}

function required(name: string): string {
  const result = argumentsByName.get(name);
  if (!result) throw new Error(`LICENSE_ARGUMENT_REQUIRED:${name}`);
  return result;
}

function value(name: string, fallback: string): string {
  return argumentsByName.get(name) ?? fallback;
}

function parseArguments(input: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < input.length; index += 1) {
    const name = input[index];
    if (!name?.startsWith('--')) throw new Error('LICENSE_ARGUMENT_INVALID');
    const next = input[index + 1];
    if (next === undefined || next.startsWith('--')) {
      result.set(name.slice(2), 'true');
    } else {
      result.set(name.slice(2), next);
      index += 1;
    }
  }
  return result;
}
