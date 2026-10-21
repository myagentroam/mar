import { describe, expect, it } from 'vitest';
import { currentChangesBranch, fileSizeLabel } from '../../src/util/file-presentation.js';

describe('shared file presentation', () => {
  it('Displays the uploaded file size in binary units and preserves up to two decimal places', () => {
    expect(fileSizeLabel(0)).toBe('0 B');
    expect(fileSizeLabel(1_023)).toBe('1023 B');
    expect(fileSizeLabel(709_830)).toBe('693.19 KB');
    expect(fileSizeLabel(1_048_576)).toBe('1 MB');
    expect(fileSizeLabel(1_073_741_824)).toBe('1 GB');
  });

  it('preserves the authoritative branch and distinguishes missing metadata from detached HEAD', () => {
    expect(currentChangesBranch({ branch: 'feature/workspace' })).toBe('feature/workspace');
    expect(currentChangesBranch({ branch: null })).toBeNull();
    expect(currentChangesBranch({ branch: '' })).toBeNull();
    expect(currentChangesBranch({})).toBeUndefined();
  });

  it('does not interpret unrelated values as branch metadata', () => {
    for (const value of [undefined, null, 'main', 5, []]) {
      expect(currentChangesBranch(value)).toBeUndefined();
    }
    expect(currentChangesBranch({ branch: false })).toBeNull();
    expect(currentChangesBranch({ branch: ['main'] })).toBeNull();
  });
});
