import { gitCredentialRequest } from './workspace/git-credential-client.js';

// SSH_ASKPASS points to node itself; NODE_OPTIONS imports this before its prompt argument.
try {
  const result = await gitCredentialRequest('/passphrase', { id: process.env.MAR_GIT_KEY_ID });
  // Keep the preload pending until stdout drains; otherwise Node tries to load the SSH prompt as its main module.
  await new Promise<void>((resolve) =>
    process.stdout.write(
      `${typeof result.passphrase === 'string' ? result.passphrase : ''}\n`,
      () => resolve()
    )
  );
  process.exit(0);
} catch {
  await new Promise<void>((resolve) =>
    process.stderr.write('Git SSH key could not be unlocked.\n', () => resolve())
  );
  process.exit(1);
}
