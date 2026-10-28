/** Settle every resource owned by the isolated shared-audit fixture before restoring its environment. */
export async function cleanupSharedAuditFixture(input: {
  readonly stopConnector: () => Promise<void>;
  readonly disposeActor: () => Promise<void>;
  readonly closeServer: () => Promise<void>;
  readonly restoreEnvironment: () => void;
  readonly removeDirectory: () => Promise<void>;
  readonly primaryFailure?: { readonly error: unknown };
}): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of [input.stopConnector, input.disposeActor, input.closeServer]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    input.restoreEnvironment();
  } catch (error) {
    errors.push(error);
  }
  try {
    await input.removeDirectory();
  } catch (error) {
    errors.push(error);
  }
  if (input.primaryFailure !== undefined) throw input.primaryFailure.error;
  if (errors.length > 0) throw errors[0];
}
