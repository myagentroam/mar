import { describe, expect, it } from 'vitest';
import {
  hostedConversationImageReadInputSchema,
  imagePreviewOptionsSchema,
  runImageReadInputSchema
} from '../../src/index.js';

describe('image preview protocol', () => {
  it('accepts optional bounded dimensions on ordinary and Hosted image reads', () => {
    const runImage = { runId: 'run-1', imageIndex: 0 };
    const hostedImage = {
      conversationId: 'conversation-1',
      runId: 'native-history:hosted:conversation-1',
      imageRef: 'file:session%3Agenerated.png'
    };
    const preview = { maxWidth: 2560, maxHeight: 2560 };

    expect(runImageReadInputSchema.parse(runImage)).toEqual(runImage);
    expect(runImageReadInputSchema.parse({ ...runImage, preview })).toEqual({
      ...runImage,
      preview
    });
    expect(hostedConversationImageReadInputSchema.parse({ ...hostedImage, preview })).toEqual({
      ...hostedImage,
      preview
    });

    expect(imagePreviewOptionsSchema.parse({ maxWidth: 1, maxHeight: 4096 })).toEqual({
      maxWidth: 1,
      maxHeight: 4096
    });
    for (const invalidPreview of [
      { maxWidth: 0, maxHeight: 240 },
      { maxWidth: -1, maxHeight: 240 },
      { maxWidth: 4097, maxHeight: 240 },
      { maxWidth: 1.5, maxHeight: 240 },
      { maxWidth: '320', maxHeight: 240 },
      { maxWidth: 320 },
      { maxWidth: 320, maxHeight: 240, extra: true }
    ]) {
      expect(imagePreviewOptionsSchema.safeParse(invalidPreview).success).toBe(false);
      expect(
        runImageReadInputSchema.safeParse({ ...runImage, preview: invalidPreview }).success
      ).toBe(false);
      expect(
        hostedConversationImageReadInputSchema.safeParse({
          ...hostedImage,
          preview: invalidPreview
        }).success
      ).toBe(false);
    }
    expect(runImageReadInputSchema.safeParse({ ...runImage, unexpected: true }).success).toBe(
      false
    );
    expect(runImageReadInputSchema.safeParse({ ...runImage, preview: null }).success).toBe(false);
  });
});
