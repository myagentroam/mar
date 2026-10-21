export function bytedArkImagegenSkill(): string {
  return `## Ark single-image generation

Use byted_ark_image_gen only for user-requested or explicitly authorized image generation or editing.
This tool uses the configured BYTED_ARK model, not the text model. Never request, inspect, print or change API keys.

For text-to-image, provide prompt and omit both image selectors.
For image-to-image, pass referenced_image_paths with existing absolute image paths, or use num_last_images_to_include for the smallest sufficient suffix of current Execution images. Never combine selectors. Do not invent missing references.
Describe which reference provides the subject, composition or style; specify what to change and what to preserve. Preserve literal requested text.
The service returns exactly one PNG with 2K size and no watermark. Group generation, video and streaming are not supported. Do not invent count, sequential, endpoint or model parameters.
In Code Mode, call tools.byted_ark_image_gen. Independent single-image calls can run with Promise.all; await earlier results when later images depend on them.

Inspect references with view_image when that tool is available. Text-only models can submit references through the Host boundary but must not claim to have visually inspected them.
Generation may take several minutes. Await the result; do not blindly retry timeouts, since the upstream may already have produced an image.
The returned path is authoritative and points to the managed Session original. Do not guess paths or overwrite user files. Copy only when needed to an explicitly authorized project destination.
Use view_image to check the result if available; otherwise state that visual inspection was not performed. Report actual paths and unmet constraints, never claim success without a returned artifact.

This Host-provided skill has no shell fallback, installation step or credential-discovery workflow.`;
}
