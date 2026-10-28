export function executionActivity(active = new Set<string>()) {
  return {
    active,
    isExecutionActive: (id: string) => active.has(id),
    executionAccepted: (id: string) => void active.add(id)
  };
}
