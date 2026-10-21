export function codexImagegenSkill(): string {
  return `## Working with images

Use codex_image_gen only when the user requests image generation or editing, or explicitly authorizes that work as part of the task. An opportunity to add a visual is not authorization. Loading this skill does not itself generate anything.

### Choose the operation
- Use AI image generation for requested raster artwork, photographs, textures, or visual variants. Prefer existing editable vector/code-native sources for deterministic changes to those assets; do not replace them with generated bitmaps merely because this tool exists.
- Distinguish a new composition, an edit target, and a reference for style or subject. Label each supplied image by index and role in the prompt. A reference-guided new composition still needs the reference pixels: pass an image selector rather than silently omitting them.
- Inspect an unseen local input with view_image when that tool is available. With a TEXT-only model, use the user-supplied reference path and instructions without claiming to have inspected pixels. Prefer referenced_image_paths when all necessary images have valid absolute paths. The Host's file boundaries still apply.
- Use num_last_images_to_include only when a necessary image has no usable path, and choose the smallest suffix containing all inputs. This is the current Execution's available in-memory images, not a permanent conversation gallery. After a new Execution or Compact, use valid saved paths or ask for missing inputs again.
- The selectors are mutually exclusive and include at most five images. Omit both only for generation without input images. Do not pretend an unavailable reference was used.

### Shape the prompt
- Preserve the user's specifics and exact requested text. Organize them into subject, intended use, composition, style, input-image roles, and constraints as useful; a fixed template is not required.
- For a vague request, supply only details that support its stated goal. Do not invent brands, slogans, additional subjects, or unrelated requirements.
- For edits, identify the target and state what changes and what must remain unchanged, including identity, layout, text, or other important details. Carry these invariants into follow-up edits.
- For lettering, quote the literal text and specify placement and typography when relevant. For multiple images, explain which image supplies each element.
- Ask for a missing decision only if it materially blocks the requested result; do not request a second approval for an already authorized operation.

### Generate and check
- Call codex_image_gen with its actual schema. It produces one PNG per call; use separate calls for separately requested assets. Do not add unsupported parameters for model, dimensions, quality, masks, output format, or destination.
- In Code Mode, call tools.codex_image_gen. Independent calls can run with Promise.all; await earlier results when later images depend on them.
- The service configuration controls model and automatic size/quality/background. A prompt can request an aspect ratio or transparency, but these are not guaranteed API settings. Check the actual result before claiming compliance.
- Generation may take minutes. Await the tool result; do not blindly repeat a timed-out or interrupted request because the upstream operation may already have run. Report failures rather than claiming an artifact exists.
- A successful result returns the saved path, not inspected pixels. When view_image is available, use it for visual acceptance: subject, exact text, composition, edit invariants, and unwanted elements. Otherwise explicitly state that visual acceptance was not performed. Make targeted corrections only within the requested scope.
- For transparent deliverables, verify actual transparency rather than treating a drawn checkerboard as alpha. Preserve the alpha channel when copying or processing the result.

### Keep and deliver
- Treat the tool-returned path as authoritative; do not guess a product HOME or generated-image directory.
- Keep the managed original. Copy selected assets into the user-requested, Host-permitted destination when needed by the project. Do not leave a project dependency pointing only at private Session storage.
- Avoid overwriting existing assets unless replacement was requested. For preview-only work the managed file can remain in place.
- If the user asks to reuse an existing image, inspect or copy it rather than generating a replacement. If it is missing, state that fact; generate again only when authorized.
- Report the actual final path and any material unmet constraints. Do not dump a long generation prompt unless the user requests it.

This Host-provided skill has no bundled command-line fallback, install step, or separate API-key requirement. Do not invent scripts or switch credentials, endpoints, or models. If the tool or a required capability is unavailable, explain the limitation. Workspace instructions can supply additional authorized workflows without changing the tool schema or Host boundaries.`;
}
