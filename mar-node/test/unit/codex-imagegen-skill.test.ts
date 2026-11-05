import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexImagegenSkill } from '../../src/runner/mar-agent/codex-imagegen-skill.js';
import { createImageGenerationExtensions } from '../../src/runner/mar-agent/image-generation-extensions.js';
import { codexImageGenToolDefinition } from '../../src/runner/mar-agent/image-generation.js';

describe('Codex image generation built-in skill', () => {
  it('uses the registered MAR tool name rather than Codex namespace or CLI conventions', () => {
    const skill = codexImagegenSkill();
    expect(skill).toContain('tools.codex_image_gen');
    expect(skill).not.toMatch(
      /image_gen\.imagegen|tools\.imagegen|OPENAI_API_KEY|scripts\/image_gen\.py|\$CODEX_HOME|generatedImage\(/u
    );
  });

  it('preserves transparent edit inputs and verifies real output transparency', () => {
    const skill = codexImagegenSkill();
    expect(skill).toContain('transparent_background: true');
    expect(skill).toContain('preserve existing transparency during edits');
    expect(skill).toContain('unless the user asks to change it');
    expect(skill).toContain('real alpha, not a drawn checkerboard');
    expect(skill).toContain('Verify the actual format and requested transparency');
  });

  it('retains references for new compositions and prefers available local paths', () => {
    const skill = codexImagegenSkill();
    expect(codexImageGenToolDefinition.description).toContain('generation without references');
    expect(skill).toContain('Omit both selectors for generation without references');
    expect(skill).toContain('Prefer paths when all inputs have them');
    expect(skill).toContain('Do not silently omit required references');
  });

  it('preserves existing assets and does not claim a failed generation succeeded', () => {
    const skill = codexImagegenSkill();
    expect(skill).toContain('Do not overwrite existing assets unless replacement was requested');
    expect(skill).toContain('Report failures rather than claiming an artifact exists');
    expect(skill).toContain('do not blindly replay an interrupted or timed-out request');
  });

  it('prepares GIF edits through inspected frames and a PNG spritesheet', () => {
    const skill = codexImagegenSkill();
    expect(skill).toContain('first inspect its frames');
    expect(skill).toContain('PNG spritesheet with equal-sized cells in a regular grid');
    expect(skill).toContain('Pass that spritesheet through referenced_image_paths and set gif');
    expect(skill).toContain('Do not pass the GIF itself as an edit input');
    expect(skill).toContain('if preparation is unavailable, explain the limitation');
  });

  it('keeps Codex animation bounds and does not equate a still preview with inspection', () => {
    const skill = codexImagegenSkill();
    expect(skill).toContain('frame_count (2–16)');
    expect(skill).toContain('frame_duration_ms (20–2000)');
    expect(skill).toContain('Defaults are 9 frames and 200 ms');
    expect(skill).toContain('For complex animation or more than 16 frames');
    expect(skill).toContain('a first-frame preview does not verify animation');
  });

  it('loads the same guidance through the Host skill catalog without accessing credentials', async () => {
    const extensions = createImageGenerationExtensions({
      configuration: {
        provider: 'CODEX',
        config: { credentialId: 'fixture', modelId: 'gpt-image-2.6-flare' },
        imageModelId: 'gpt-image-2.6-flare',
        generateEndpoint: 'https://example.test/images/generations',
        editEndpoint: 'https://example.test/images/edits',
        httpVersion: '1.1',
        credentialProvider: {
          acquire: async () => {
            throw new Error('Skill loading must not acquire credentials.');
          },
          invalidate: () => undefined,
          close: async () => undefined
        }
      },
      homeDirectory: join(tmpdir(), 'codex-skill-fixture'),
      host: () => {
        throw new Error('Skill loading must not invoke the Host.');
      }
    });
    const tool = extensions.tools?.[0];
    const skill = extensions.skills?.[0];
    expect(tool?.name).toBe('codex_image_gen');
    expect(skill?.name).toBe('codex-imagegen');
    expect(skill?.requiredTools).toEqual([tool?.name]);
    expect(await skill?.load()).toBe(codexImagegenSkill());
  });
});
