import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Server Codex runtime app wiring', () => {
  it('constructs one credential chain and injects it into Node control and all MAR Agent routes', async () => {
    const source = await readFile(resolve(process.cwd(), 'ee/server/src/app.ts'), 'utf8');

    expect(source).toContain(
      "import { CodexCredentialService } from './service/codex-credential-service.js';"
    );
    expect(source).toContain('loadOrCreateRuntimeCredentialHmacKey');
    expect(source).toContain("from './service/runtime-credential-service.js';");
    expect(source).toMatch(
      /import\s*\{[^}]*\bMarAgentRuntimeModelService\b[^}]*\}\s*from '\.\/service\/mar-agent-runtime-model-service\.js'/u
    );
    expect(source).toContain(
      "import { registerCodexCredentialRoutes } from './route/codex-credential-routes.js';"
    );
    expect(source).toContain('const codexCredentials =');
    expect(source).toContain('const runtimeCredentials =');
    expect(source).toContain('const marAgentRuntimeModels =');
    expect(source).toContain('hmacKey: loadOrCreateRuntimeCredentialHmacKey(dataDirectory)');
    expect(source).toContain('nodeControl.setRuntimeCredentialService(runtimeCredentials);');
    expect(source).toContain('registerCodexCredentialRoutes({');
    expect(source).toContain("codexCredentials.maintain('STARTUP')");
    expect(source).toContain("codexCredentials.maintain('EXPIRING')");
    expect(source).toContain('CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS');
    expect(source).toContain('clearInterval(codexCredentialMaintenanceTimer)');
    expect(
      source.match(/\.\.\.\(marAgentRuntimeModels === undefined/g)?.length
    ).toBeGreaterThanOrEqual(3);
  });
});
