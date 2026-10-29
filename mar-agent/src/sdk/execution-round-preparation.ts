/** Owns round retries when late input or resource collection invalidates a candidate. */
export function createExecutionRoundPreparer<Continuation, Candidate, Round>(ports: {
  prepareInputs(includeSessionContext: boolean): Promise<void>;
  buildCandidate(continuation: Continuation | undefined): Promise<Candidate>;
  adoptLateInput(): Promise<boolean>;
  prepareResources(candidate: Candidate): Promise<{ round: Round } | { retry: true }>;
}) {
  return async (continuation: Continuation | undefined): Promise<Round> => {
    let includeSessionContext = true;
    for (;;) {
      await ports.prepareInputs(includeSessionContext);
      const candidate = await ports.buildCandidate(continuation);
      if (await ports.adoptLateInput()) {
        includeSessionContext = false;
        continue;
      }
      const prepared = await ports.prepareResources(candidate);
      if ('round' in prepared) return prepared.round;
      includeSessionContext = false;
    }
  };
}
