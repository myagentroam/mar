export interface ProductCapabilities {
  readonly edition: 'COMMUNITY' | 'ENTERPRISE';
  readonly licenseState: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
  readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  readonly organizationId: number | null;
  readonly managementWritable: boolean;
}

export interface ProductCapabilityProvider {
  capability(userId: number): Promise<ProductCapabilities>;
}
