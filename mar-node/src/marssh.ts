#!/usr/bin/env node

const entrypoint: string = '@myagentroam/marctl/bin/marssh.mjs';
await import(entrypoint);
