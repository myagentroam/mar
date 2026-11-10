import { describe, expect, it } from 'vitest';
import { searchSetupFailureCode } from '../../mar-server/src/quick-start/search-errors.js';

describe('Quick Start search setup diagnostics', () => {
  it('retains only known stable classifications and never forwards arbitrary error details', () => {
    expect(searchSetupFailureCode(new Error('QUICK_START_SEARCH_COMPONENT_NOT_OWNED'))).toBe(
      'QUICK_START_SEARCH_COMPONENT_NOT_OWNED'
    );
    expect(
      searchSetupFailureCode(new Error('download failed https://example.invalid/private'))
    ).toBe('QUICK_START_SEARCH_INSTALL_FAILED');
  });
});
