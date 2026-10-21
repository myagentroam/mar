import { rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function check(value, code) {
  if (!value) throw new Error(code);
}

export async function cleanBuildOutput(directory, workingDirectory = process.cwd()) {
  check(
    typeof directory === 'string' &&
      directory.length > 0 &&
      !isAbsolute(directory) &&
      !directory.includes('\\') &&
      directory.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'BUILD_OUTPUT_PATH_INVALID'
  );
  const target = resolve(workingDirectory, directory);
  check(target !== resolve(workingDirectory), 'BUILD_OUTPUT_PATH_INVALID');
  await rm(target, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory] = process.argv.slice(2);
  await cleanBuildOutput(directory);
}
