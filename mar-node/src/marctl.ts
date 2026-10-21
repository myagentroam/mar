#!/usr/bin/env node

// Keep the CLI implementation in its own package; the Node install exposes the same entrypoint.
const entrypoint: string = '@myagentroam/marctl/bin/marctl.mjs';
await import(entrypoint);
