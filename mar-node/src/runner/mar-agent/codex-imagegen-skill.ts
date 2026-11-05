export function codexImagegenSkill(): string {
  return `## Working with images

Use codex_image_gen only for image generation or editing the user requests or explicitly authorizes. Loading this skill is not authorization to add visuals.

### Choose the operation
- Use generated raster artwork for photos, illustrations, textures, and visual variants. Prefer direct source edits for existing SVG, icons, and other code-native assets.
- Omit both selectors for generation without references. Otherwise use up to five absolute referenced_image_paths, or the smallest num_last_images_to_include containing all needed images, never both. Prefer paths when all inputs have them. Recent images belong to this Execution, not a permanent gallery; after recovery or Compact, use saved paths or ask for missing inputs.
- Identify each reference's role. Inspect unseen PNG/JPEG/WebP inputs with view_image when available; TEXT-only models must not claim visual inspection. Do not silently omit required references.

### Shape the prompt
- State the subject, composition, style, and essential constraints; preserve exact requested lettering. For edits, specify what changes and what stays unchanged. Add only details that support the user's goal; clarify only when a missing decision blocks the result.
- Set transparent_background: true for cutouts, background removal, or transparency; preserve existing transparency during edits unless the user asks to change it. Preserve real alpha, not a drawn checkerboard.
- For a simple looping animation, set gif: {} or specify frame_count (2–16) and frame_duration_ms (20–2000). Defaults are 9 frames and 200 ms. Describe the motion and loop seam; keep subjects and camera stable unless asked otherwise.
- To edit a GIF, first inspect its frames and use available tools to make a PNG spritesheet with equal-sized cells in a regular grid. Pass that spritesheet through referenced_image_paths and set gif. Do not pass the GIF itself as an edit input; if preparation is unavailable, explain the limitation.
- For complex animation or more than 16 frames, use suitable available tools or explain the limit rather than stretching this tool's bounds.

### Generate and check
- One PNG or GIF is saved per call. Model, quality, and size remain service-controlled; do not invent API parameters, output paths, SVG support, or fallback tools.
- In Code Mode, call tools.codex_image_gen. Independent calls may use Promise.all; dependent edits must await their inputs. Generation can take minutes: await the result and do not blindly replay an interrupted or timed-out request. Report failures rather than claiming an artifact exists.
- Verify the actual format and requested transparency, then check PNG content (subject, lettering, and edit invariants) with view_image when available. For GIFs, check frames, timing, and the loop with available animation-aware tools; a first-frame preview does not verify animation. If inspection is unavailable, say so. Correct only issues within the requested scope.

### Keep and deliver
- Trust the returned path and keep the managed original. Copy assets into the authorized project destination when needed; do not leave project dependencies in private Session storage. Do not overwrite existing assets unless replacement was requested.
- Reuse existing images when requested rather than regenerating them. Report the final path and material unmet constraints, not a long prompt dump.

This Host-provided skill has no bundled CLI fallback or separate API-key setup. Do not switch credentials, endpoints, or models. Follow the tool schema and Host file boundaries.`;
}
