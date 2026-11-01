/** Stop scheduling on the first failure, then drain all in-flight filesystem operations. */
export async function forEachTransactionFile<T>(
  files: readonly T[],
  operation: (file: T) => Promise<unknown>
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(8, files.length) }, async () => {
      while (!failed && next < files.length) {
        const file = files[next++]!;
        try {
          await operation(file);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    })
  );
  if (failed) throw failure;
}
