export interface ExtensionCapabilitySnapshot {
  has(id: string): boolean;
  list(): readonly string[];
}
