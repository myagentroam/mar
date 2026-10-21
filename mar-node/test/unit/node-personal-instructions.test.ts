import { describe, expect, it } from 'vitest';
import {
  normalizeSessionPrompt,
  personalInstructionsForRunner,
  withSessionPrompt
} from '../../src/util/personal-instructions.js';

describe('Node personal instructions', () => {
  const value = {
    common: 'Shared rule',
    codex: 'Codex rule',
    claudeCode: 'Claude rule',
    openCode: 'OpenCode rule',
    marAgent: 'MAR Agent rule'
  };

  it('combines shared and runner-specific instructions for the actual Runner', () => {
    expect(personalInstructionsForRunner(value, 'codex')).toBe('Shared rule\n\nCodex rule');
    expect(personalInstructionsForRunner(value, 'claude-code')).toBe('Shared rule\n\nClaude rule');
    expect(personalInstructionsForRunner(value, 'opencode')).toBe('Shared rule\n\nOpenCode rule');
    expect(personalInstructionsForRunner(value, 'mar-agent')).toBe('Shared rule\n\nMAR Agent rule');
  });

  it('allows either side to be empty and rejects non-string values', () => {
    expect(
      personalInstructionsForRunner(
        { ...value, common: '', codex: 'Runner-specific rule' },
        'codex'
      )
    ).toBe('Runner-specific rule');
    expect(personalInstructionsForRunner({ ...value, codex: '' }, 'codex')).toBe('Shared rule');
    expect(personalInstructionsForRunner(undefined, 'codex')).toBeUndefined();
    expect(() => personalInstructionsForRunner({ common: 1 }, 'codex')).toThrow(
      'PERSONAL_INSTRUCTION_INVALID'
    );
  });

  it('normalizes Session Prompts, clears empty values, and enforces the 20,000-character limit', () => {
    expect(normalizeSessionPrompt('  Only for this session  \n')).toBe('Only for this session');
    expect(normalizeSessionPrompt(' \t\n ')).toBeNull();
    expect(normalizeSessionPrompt(null)).toBeNull();

    const maximum = 'x'.repeat(20_000);
    expect(normalizeSessionPrompt(` ${maximum} `)).toBe(maximum);
    expect(() => normalizeSessionPrompt(`${maximum}x`)).toThrow('SESSION_PROMPT_INVALID');
    expect(() => normalizeSessionPrompt(1)).toThrow('SESSION_PROMPT_INVALID');
  });

  it('appends a Session Prompt after shared and Runner-specific instructions, including without personal instructions', () => {
    const personal = personalInstructionsForRunner(value, 'codex');
    expect(withSessionPrompt(personal, 'Session-only rule')).toBe(
      'Shared rule\n\nCodex rule\n\nSession-only rule'
    );
    expect(withSessionPrompt(undefined, 'Session-only rule')).toBe('Session-only rule');
    expect(withSessionPrompt(personal, null)).toBe('Shared rule\n\nCodex rule');
    expect(withSessionPrompt(undefined, null)).toBeUndefined();
  });
});
