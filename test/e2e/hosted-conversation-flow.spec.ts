import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import mysql from 'mysql2/promise';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page
} from '@playwright/test';
import type {
  ConversationFileProjection,
  HostedConversationFileReadResult,
  HostedConversationFiles,
  HostedConversationSnapshot
} from '../../packages/protocol/src/index.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { loadPermissionMatrix } from '../../ee/server/src/rbac/permission-matrix.js';
import { ResourceGrantService } from '../../ee/server/src/rbac/resource-grant-service.js';
import { CodexCredentialService } from '../../ee/server/src/service/codex-credential-service.js';
import {
  createEnterpriseTestServer,
  type EnterpriseTestServer
} from './support/enterprise-test-server.js';
import { createPlaywrightTestLicenseDocument } from './support/playwright-test-license.js';
import {
  makeWritable,
  startResponsesServer,
  templateDraft
} from './support/hosted-conversation-flow-fixture.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import { isolatedRunnerEnvironment } from '../support/isolate-runner-environment.js';

interface AuthenticatedContext {
  readonly context: APIRequestContext;
  readonly csrfToken: string;
  readonly cookie: string;
}

interface NodeProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
}

interface HostedImageSeed {
  readonly runId: string;
  readonly root: string;
  readonly path: string;
  readonly name: string;
  readonly mime: string;
}

interface HostedConversationDiskSession {
  readonly homeDirectory: string;
  readonly sessionId: string;
}

interface WorkbenchWatchClient {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly connectionId: string;
}

test('Real Server and Node cover template publication, user isolation, Run-boundary upgrades, template switching, index rebuilding, and permanent deletion', async ({
  browser,
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chromium-only API integration coverage');
  test.setTimeout(180_000);

  const runsDirectory = join(process.cwd(), 'test', 'runs');
  await mkdir(runsDirectory, { recursive: true });
  const root = await mkdtemp(join(runsDirectory, 'mar-hosted-conversation-e2e-'));
  const workspace = join(root, 'workspace');
  const knowledge = join(workspace, 'knowledge');
  const nodeData = await mkdtemp(join(tmpdir(), 'my-agent-roam-hosted-conversation-node-'));
  const hostedRoot = join(nodeData, 'hosted-conversations');
  const configPath = join(root, 'node.json');
  const nodeDatabasePath = join(nodeData, 'node-runtime.sqlite');
  const modelRequests: unknown[] = [];
  let server: EnterpriseTestServer | undefined;
  let modelServer: Server | undefined;
  let node: NodeProcess | undefined;
  let database: MysqlServerDatabase | undefined;
  let admin: AuthenticatedContext | undefined;
  let member: AuthenticatedContext | undefined;
  let adminWatch: WorkbenchWatchClient | undefined;
  let memberWatch: WorkbenchWatchClient | undefined;

  try {
    server = await createEnterpriseTestServer('hosted-conversation');
    const webUrl = server.baseURL;
    await mkdir(knowledge, { recursive: true });
    await mkdir(join(workspace, '.venv', 'bin'), { recursive: true });
    await writeFile(join(workspace, 'README.md'), 'Template maintainer guide only.\n');
    await writeFile(join(workspace, 'AGENTS.md'), 'Template maintainer instructions only.\n');
    await writeFile(join(workspace, 'AGENTS.template.md'), 'Use template version one.\n');
    await writeFile(join(knowledge, 'guide.md'), 'template version one\n');
    await symlink('/usr/bin/python3', join(workspace, '.venv', 'bin', 'python'));
    await writeFile(
      join(workspace, '.venv', 'bin', 'template-tool'),
      `#!${join(workspace, '.venv', 'bin', 'python')}\nprint("template tool")\n`,
      { mode: 0o755 }
    );
    const fakeModel = await startResponsesServer(modelRequests, workspace);
    modelServer = fakeModel.server;

    admin = await login(webUrl, 'admin', INITIAL_ADMIN_PASSWORD, 'HostedAdminPassword123!');
    await writeJson(admin, 'POST', '/api/license/import', {
      document: createPlaywrightTestLicenseDocument()
    });
    const pool = mysql.createPool(server.databaseUrl);
    database = new MysqlServerDatabase(pool);
    const [adminRows] = await database.raw.execute<mysql.RowDataPacket[]>(
      'SELECT id,organization_id FROM users WHERE is_fixed_admin=TRUE'
    );
    const adminUserId = Number(adminRows[0]?.['id']);
    const rootOrganizationId = Number(adminRows[0]?.['organization_id']);
    expect(Number.isSafeInteger(adminUserId)).toBe(true);
    expect(Number.isSafeInteger(rootOrganizationId)).toBe(true);
    const registration = await writeJson<{ token: string }>(
      admin,
      'POST',
      '/api/node-registration-tokens',
      {
        displayName: 'Hosted E2E Node',
        ownership: {
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: rootOrganizationId
        }
      }
    );
    const udp = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', resolve);
    });
    const udpPort = udp.address().port;
    await new Promise<void>((resolve) => udp.close(() => resolve()));
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          serverUrl: webUrl,
          allowedRoots: [workspace],
          dataDirectory: nodeData,
          registrationToken: registration.token,
          directTransfer: { udpPortRangeBegin: udpPort, udpPortRangeEnd: udpPort },
          conversationHosting: {
            enabled: true,
            storeDirectory: 'hosted-conversations',
            inactiveRetentionDays: 60
          }
        },
        undefined,
        2
      )}\n`
    );

    node = startNodeConnector(configPath);
    const connectedNode = await waitForHostedNode(admin.context);
    expect(connectedNode.conversationHosting).toMatchObject({ state: 'AVAILABLE' });
    const nodeId = connectedNode.id;

    const workspaceResult = await writeJson<{ workspace: { id: string } }>(
      admin,
      'POST',
      '/api/workspaces',
      {
        nodeId,
        path: workspace,
        ownership: {
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: rootOrganizationId
        }
      },
      201
    );
    const workspaceId = workspaceResult.workspace.id;

    const modelResult = await writeJson<{ model: { id: string } }>(
      admin,
      'POST',
      '/api/admin/mar-agent/models',
      {
        name: 'Hosted E2E',
        ownership: {
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: rootOrganizationId
        },
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://models.example.test/v1',
        apiKey: 'hosted-e2e-key',
        modelId: 'hosted-e2e-model',
        contextWindowTokens: 128_000,
        maxOutputTokens: 4_096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true,
        sortOrder: 0
      },
      201
    );
    const modelId = modelResult.model.id;
    const authorization = new AuthorizationService(database, loadPermissionMatrix());
    const resources = new ResourceGrantService(
      database,
      authorization,
      new CodexCredentialService(database, { authorization })
    );
    await resources.createGrant(adminUserId, 'MODEL', modelId, null, {
      targetType: 'ORGANIZATION',
      targetOrganizationId: 1
    });
    const draft = templateDraft(nodeId, workspaceId);
    const createdTemplate = await writeJson<{
      template: { id: string };
      draft: { revision: number };
    }>(admin, 'POST', '/api/admin/conversation-templates', draft, 201);
    const templateId = createdTemplate.template.id;

    expect(
      await readJson<{ templates: unknown[] }>(admin.context, '/api/conversation-templates')
    ).toEqual({ templates: [] });

    const versionOne = await publishTemplate(
      admin,
      templateId,
      createdTemplate.draft.revision,
      'hosted-e2e-publish-v1',
      1
    );
    await writeFile(join(knowledge, 'guide.md'), 'live source changed without publish\n');

    await database.raw.execute('UPDATE mar_agent_models SET base_url=? WHERE id=?', [
      `${fakeModel.baseUrl}/v1`,
      modelId
    ]);
    const memberPassword = 'HostedMemberPassword123!';
    const memberUserId = await database.createUser({
      username: 'hosted-member',
      email: null,
      nickname: 'Hosted Member',
      password: memberPassword
    });
    await database.raw.execute(
      `UPDATE users SET organization_id=?,role='MEMBER',updated_at=? WHERE id=?`,
      [rootOrganizationId, Date.now(), memberUserId]
    );
    await resources.createGrant(adminUserId, 'TEMPLATE', templateId, null, {
      targetType: 'ORGANIZATION',
      targetOrganizationId: rootOrganizationId
    });

    member = await login(webUrl, 'hosted-member', memberPassword, 'HostedMemberChanged123!');
    const memberCatalog = await readJson<{ templates: Array<{ id: string }> }>(
      member.context,
      '/api/conversation-templates'
    );
    expect(memberCatalog.templates.map((template) => template.id)).toEqual([templateId]);

    const adminConversation = await createConversation(
      admin,
      nodeId,
      templateId,
      'hosted-e2e-admin-create'
    );
    const memberConversation = await createConversation(
      member,
      nodeId,
      templateId,
      'hosted-e2e-member-create'
    );
    expect(adminConversation.activeVersionId).toBe(versionOne);
    expect(memberConversation.activeVersionId).toBe(versionOne);
    expect(adminConversation).toMatchObject({
      title: 'New conversation',
      titleSource: 'DEFAULT'
    });
    expect(memberConversation).toMatchObject({
      title: 'New conversation',
      titleSource: 'DEFAULT'
    });

    await expectOwnConversation(admin.context, nodeId, adminConversation.id, memberConversation.id);
    await expectOwnConversation(
      member.context,
      nodeId,
      memberConversation.id,
      adminConversation.id
    );
    const diskSessions = await expectUserDirectories(hostedRoot, [
      adminConversation.id,
      memberConversation.id
    ]);
    const adminDiskSession = diskSessions.get(adminConversation.id);
    if (adminDiskSession === undefined) throw new Error('HOSTED_ADMIN_DISK_SESSION_MISSING');
    await Promise.all(
      [...diskSessions.values()].map(({ homeDirectory }) =>
        writeFile(join(homeDirectory, 'sdk-home-marker.txt'), 'sdk home marker must stay private\n')
      )
    );
    adminWatch = await openWorkbenchWatch(browser, webUrl, admin.cookie);
    await startHostedWatch(
      admin,
      nodeId,
      adminConversation.id,
      adminWatch.connectionId,
      'hosted-e2e-admin-watch'
    );
    await waitForWatchFrame(
      adminWatch.page,
      (frame) =>
        frame.type === 'watch.event' &&
        record(frame.event)?.type === 'watch.hosted-conversation.snapshot' &&
        record(frame.event)?.conversationId === adminConversation.id
    );

    const forged = await member.context.post(
      `/api/nodes/${nodeId}/hosted-conversations/${memberConversation.id}/messages`,
      {
        headers: { 'x-csrf-token': member.csrfToken },
        data: {
          clientMessageId: 'hosted-e2e-forged',
          prompt: 'forged',
          attachmentIds: [],
          modelId,
          reasoningEffort: 'high',
          runner: 'codex',
          access: 'full-access',
          command: '/compact'
        }
      }
    );
    expect(forged.status()).toBe(400);
    expect(modelRequests).toHaveLength(0);

    await sendMessage(
      admin,
      nodeId,
      adminConversation.id,
      modelId,
      'hosted-e2e-admin-message-1',
      '第一轮'
    );
    const firstSnapshot = await waitForSnapshot(
      admin.context,
      nodeId,
      adminConversation.id,
      (snapshot) => JSON.stringify(snapshot).includes('First hosted reply')
    );
    await waitForWatchFrame(
      adminWatch.page,
      (frame) =>
        hostedWatchPayload(frame, adminConversation.id)?.kind === 'run' &&
        record(hostedWatchPayload(frame, adminConversation.id)?.run)?.status === 'RUNNING'
    );
    await waitForWatchFrame(
      adminWatch.page,
      (frame) =>
        hostedWatchPayload(frame, adminConversation.id)?.kind === 'runtime' &&
        record(hostedWatchPayload(frame, adminConversation.id)?.runtimeEvent)?.kind === 'DELTA'
    );
    await waitForWatchFrame(
      adminWatch.page,
      (frame) =>
        hostedWatchPayload(frame, adminConversation.id)?.kind === 'run' &&
        record(hostedWatchPayload(frame, adminConversation.id)?.run)?.status === 'SUCCEEDED'
    );
    expect(firstSnapshot.conversation.activeVersionId).toBe(versionOne);
    expect(
      modelRequests.some((request) => JSON.stringify(request).includes('Use template version one.'))
    ).toBe(true);
    expect(
      modelRequests.every(
        (request) => !JSON.stringify(request).includes('Template maintainer instructions only.')
      )
    ).toBe(true);
    const sandboxCommand = firstSnapshot.turns
      .flatMap((turn) => turn.items)
      .find(
        (item) =>
          item.kind === 'command_execution' && item.payload.command.includes('HOSTED_SANDBOX_HOME')
      );
    expect(sandboxCommand).toBeDefined();
    if (sandboxCommand?.kind !== 'command_execution')
      throw new Error('HOSTED_SANDBOX_COMMAND_MISSING');
    expect(sandboxCommand).toMatchObject({
      status: 'COMPLETED',
      payload: {
        exitCode: 0,
        output: {
          blocks: expect.arrayContaining([
            { channel: 'STDOUT', text: expect.stringContaining('HOSTED_SANDBOX_HOME=/home/mar') }
          ])
        }
      }
    });
    const sandboxOutput = sandboxCommand.payload.output;
    if (!sandboxOutput || !('blocks' in sandboxOutput)) throw new Error('HOSTED_OUTPUT_MISSING');
    const sandboxStdout = sandboxOutput.blocks.find((block) => block.channel === 'STDOUT')?.text;
    expect(sandboxStdout).toContain('SDK_SESSION_HOME_MARKER=hidden');
    expect(sandboxStdout).toContain('HOSTED_ALIAS_GUIDE=template version one');
    expect(sandboxStdout).toContain('HOSTED_TEMPLATE_TOOL=template tool');
    expect(sandboxStdout).toMatch(
      /HOSTED_ADDRESS_LIMIT=(?:unlimited|4194304|[5-9][0-9]{6,}|[1-9][0-9]{7,})/u
    );
    for (const { homeDirectory } of diskSessions.values()) {
      await expect(readFile(join(homeDirectory, 'sdk-home-marker.txt'), 'utf8')).resolves.toBe(
        'sdk home marker must stay private\n'
      );
      await expect(lstat(join(homeDirectory, 'sandbox-write-marker.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    }
    const generatedImageSessionDirectory = join(
      adminDiskSession.homeDirectory,
      '.mar',
      'agent',
      'sessions',
      adminDiskSession.sessionId
    );
    const generatedImagesDirectory = join(generatedImageSessionDirectory, 'generated_images');
    const previousImageBytes = Buffer.from('previous hosted generated image');
    await mkdir(generatedImagesDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(generatedImagesDirectory, 'previous.png'), previousImageBytes);
    await writeFile(
      join(generatedImageSessionDirectory, 'private-session-marker.txt'),
      'must stay hidden\n'
    );
    const generatedImagesLogicalPath = `/home/mar/.mar/agent/sessions/${adminDiskSession.sessionId}/generated_images`;
    const requestsBeforeImageCopy = modelRequests.length;

    await sendMessage(
      admin,
      nodeId,
      adminConversation.id,
      modelId,
      'hosted-e2e-admin-copy-generated-image',
      '复制之前生成的图片'
    );
    const copiedImageSnapshot = await waitForSnapshot(
      admin.context,
      nodeId,
      adminConversation.id,
      (snapshot) => JSON.stringify(snapshot).includes('Copied previous generated image')
    );
    const copyCommand = copiedImageSnapshot.turns
      .flatMap((turn) => turn.items)
      .find(
        (item) =>
          item.kind === 'command_execution' &&
          item.payload.command.includes('HOSTED_GENERATED_IMAGE_COPY')
      );
    expect(copyCommand).toBeDefined();
    if (copyCommand?.kind !== 'command_execution')
      throw new Error('HOSTED_GENERATED_IMAGE_COPY_COMMAND_MISSING');
    expect(copyCommand).toMatchObject({
      status: 'COMPLETED',
      payload: {
        exitCode: 0,
        output: {
          blocks: expect.arrayContaining([
            { channel: 'STDOUT', text: expect.stringContaining('HOSTED_GENERATED_IMAGE_COPY=ok') }
          ])
        }
      }
    });
    await expect(
      readFile(join(adminDiskSession.homeDirectory, '..', 'data', 'output', 'copied-previous.png'))
    ).resolves.toEqual(previousImageBytes);
    const projectedImage = await waitForHostedFile(
      admin.context,
      nodeId,
      adminConversation.id,
      'copied-previous.png'
    );
    expect(projectedImage).toMatchObject({
      category: 'OUTPUT',
      relativePath: 'copied-previous.png',
      source: 'AGENT',
      size: previousImageBytes.length
    });
    const projectedImageRead = await readJson<HostedConversationFileReadResult>(
      admin.context,
      `/api/nodes/${nodeId}/hosted-conversations/${adminConversation.id}/files/${projectedImage.id}?offset=0&limit=1024`
    );
    expect(projectedImageRead).toMatchObject({
      file: { id: projectedImage.id },
      encoding: 'base64',
      offset: 0,
      nextOffset: null,
      eof: true
    });
    expect(Buffer.from(projectedImageRead.content, 'base64')).toEqual(previousImageBytes);
    await expect(readFile(join(generatedImagesDirectory, 'previous.png'))).resolves.toEqual(
      previousImageBytes
    );
    await expect(
      readFile(join(generatedImageSessionDirectory, 'private-session-marker.txt'), 'utf8')
    ).resolves.toBe('must stay hidden\n');
    const imageCopyRequests = modelRequests.slice(requestsBeforeImageCopy);
    expect(
      imageCopyRequests.some((request) =>
        JSON.stringify(request).includes(generatedImagesLogicalPath)
      )
    ).toBe(true);
    expect(
      imageCopyRequests.every(
        (request) => !JSON.stringify(request).includes(adminDiskSession.homeDirectory)
      )
    ).toBe(true);
    const requestsAfterImageCopy = modelRequests.length;

    await writeFile(join(knowledge, 'guide.md'), 'template version two\n');
    await writeFile(join(workspace, 'AGENTS.template.md'), 'Use template version two.\n');
    const updatedTemplate = await writeJson<{ draft: { revision: number } }>(
      admin,
      'PUT',
      `/api/admin/conversation-templates/${templateId}`,
      {
        ...draft,
        draftRevision: createdTemplate.draft.revision
      }
    );
    const versionTwo = await publishTemplate(
      admin,
      templateId,
      updatedTemplate.draft.revision,
      'hosted-e2e-publish-v2',
      2
    );
    const beforeUpgrade = await readJson<HostedConversationSnapshot>(
      admin.context,
      `/api/nodes/${nodeId}/hosted-conversations/${adminConversation.id}`
    );
    expect(beforeUpgrade.conversation.activeVersionId).toBe(versionOne);

    await sendMessage(
      admin,
      nodeId,
      adminConversation.id,
      modelId,
      'hosted-e2e-admin-message-2',
      '第二轮'
    );
    const upgradedSnapshot = await waitForSnapshot(
      admin.context,
      nodeId,
      adminConversation.id,
      (snapshot) =>
        snapshot.conversation.activeVersionId === versionTwo &&
        JSON.stringify(snapshot).includes('First hosted reply') &&
        JSON.stringify(snapshot).includes('Second hosted reply')
    );
    expect(upgradedSnapshot.conversation.status).toBe('ACTIVE');
    const resumedWorkCommand = upgradedSnapshot.turns
      .flatMap((turn) => turn.items)
      .find(
        (item) =>
          item.kind === 'command_execution' &&
          item.payload.command.includes('HOSTED_OUTPUT_WORK_RESUME')
      );
    expect(resumedWorkCommand).toBeDefined();
    if (resumedWorkCommand?.kind !== 'command_execution')
      throw new Error('HOSTED_OUTPUT_WORK_RESUME_COMMAND_MISSING');
    expect(resumedWorkCommand).toMatchObject({
      status: 'COMPLETED',
      payload: {
        exitCode: 0,
        output: {
          blocks: expect.arrayContaining([
            { channel: 'STDOUT', text: expect.stringContaining('HOSTED_OUTPUT_WORK_RESUME=ok') }
          ])
        }
      }
    });
    expect(
      modelRequests.slice(requestsAfterImageCopy).some((request) => {
        const body = JSON.stringify(request);
        return (
          body.includes('第一轮') && body.includes('First hosted reply') && body.includes('第二轮')
        );
      })
    ).toBe(true);

    await stopNodeConnector(node);
    node = undefined;
    const offline = await admin.context.get(`/api/nodes/${nodeId}/hosted-conversations?limit=20`);
    expect(offline.status()).toBe(409);
    expect(await offline.json()).toMatchObject({ error: { code: 'NODE_OFFLINE' } });
    clearHostedConversationIndex(nodeDatabasePath);

    const hostedImageBytes = Buffer.from('hosted-member-image');
    const hostedImagePath = join(root, 'hosted-member-image.png');
    const hostedImageRunId = `native-history:hosted:${memberConversation.id}`;
    await writeFile(hostedImagePath, hostedImageBytes);
    node = startNodeConnector(configPath, {
      runId: hostedImageRunId,
      root,
      path: hostedImagePath,
      name: 'hosted-member-image.png',
      mime: 'image/png'
    });
    const reconnectedNode = await waitForHostedNode(admin.context, nodeId);
    expect(reconnectedNode.conversationHosting).toMatchObject({ state: 'AVAILABLE' });
    await expectOwnConversation(admin.context, nodeId, adminConversation.id, memberConversation.id);
    await expectOwnConversation(
      member.context,
      nodeId,
      memberConversation.id,
      adminConversation.id
    );
    const recoveredAdmin = await waitForSnapshot(
      admin.context,
      nodeId,
      adminConversation.id,
      (snapshot) =>
        snapshot.conversation.activeVersionId === versionTwo &&
        JSON.stringify(snapshot).includes('First hosted reply') &&
        JSON.stringify(snapshot).includes('Second hosted reply')
    );
    expect(recoveredAdmin.conversation.status).toBe('ACTIVE');

    await expect.poll(() => node!.output().match(/HOSTED_IMAGE_REF=(\S+)/u)?.[1]).toBeTruthy();
    const hostedImageRef = node.output().match(/HOSTED_IMAGE_REF=(\S+)/u)![1]!;
    const hostedImageUrl =
      `/api/nodes/${nodeId}/hosted-conversations/${memberConversation.id}` +
      `/runs/${encodeURIComponent(hostedImageRunId)}/images/${encodeURIComponent(hostedImageRef)}`;
    const hostedImage = await member.context.get(hostedImageUrl);
    expect(hostedImage.status()).toBe(200);
    expect(hostedImage.headers()['content-type']).toContain('image/png');
    expect(await hostedImage.body()).toEqual(hostedImageBytes);
    expect(hostedImage.headers()['cache-control']).toBe('private, no-store');
    const updatedHostedImageBytes = Buffer.from('updated-hosted-member-image');
    await writeFile(hostedImagePath, updatedHostedImageBytes);
    const refreshedHostedImage = await member.context.get(hostedImageUrl, {
      headers: { 'if-none-match': '"old-native-image"' }
    });
    expect(refreshedHostedImage.status()).toBe(200);
    expect(refreshedHostedImage.headers()['cache-control']).toBe('private, no-store');
    expect(await refreshedHostedImage.body()).toEqual(updatedHostedImageBytes);
    const ordinaryImage = await member.context.get(
      `/api/agent-runs/${encodeURIComponent(hostedImageRunId)}/images/${encodeURIComponent(hostedImageRef)}?nodeId=${encodeURIComponent(nodeId)}`
    );
    expect(ordinaryImage.status()).toBe(400);
    expect(await ordinaryImage.json()).toMatchObject({ error: { code: 'RUN_IMAGE_INVALID' } });
    const crossConversationImage = await admin.context.get(hostedImageUrl);
    expect(crossConversationImage.status()).toBe(403);
    expect(await crossConversationImage.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_NOT_AUTHORIZED' }
    });

    await sendMessage(
      member,
      nodeId,
      memberConversation.id,
      modelId,
      'hosted-e2e-member-message-1',
      '成员恢复轮'
    );
    const recoveredMember = await waitForSnapshot(
      member.context,
      nodeId,
      memberConversation.id,
      (snapshot) =>
        snapshot.conversation.activeVersionId === versionTwo &&
        JSON.stringify(snapshot).includes('Recovered member reply')
    );
    expect(recoveredMember.conversation.status).toBe('ACTIVE');

    await writeFile(join(knowledge, 'guide.md'), 'template version three\n');
    await writeFile(join(workspace, 'AGENTS.template.md'), 'Use template version three.\n');
    const deletingTemplate = await writeJson<{ draft: { revision: number } }>(
      admin,
      'PUT',
      `/api/admin/conversation-templates/${templateId}`,
      {
        ...draft,
        draftRevision: updatedTemplate.draft.revision
      }
    );
    const versionThree = await publishTemplate(
      admin,
      templateId,
      deletingTemplate.draft.revision,
      'hosted-e2e-publish-v3-before-delete',
      3
    );
    expect(versionThree).not.toBe(versionTwo);
    const beforeDelete = await readJson<HostedConversationSnapshot>(
      member.context,
      `/api/nodes/${nodeId}/hosted-conversations/${memberConversation.id}`
    );
    expect(beforeDelete.conversation.activeVersionId).toBe(versionTwo);

    await writeNoContent(admin, 'DELETE', `/api/admin/conversation-templates/${templateId}`, {});
    expect(
      await readJson<{ templates: unknown[] }>(member.context, '/api/conversation-templates')
    ).toEqual({ templates: [] });
    const createAfterDelete = await member.context.post(
      `/api/nodes/${nodeId}/hosted-conversations`,
      {
        headers: { 'x-csrf-token': member.csrfToken },
        data: {
          templateId,
          clientRequestId: 'hosted-e2e-create-after-delete'
        }
      }
    );
    expect(createAfterDelete.status()).toBe(409);
    expect(await createAfterDelete.json()).toMatchObject({
      error: { code: 'CONVERSATION_TEMPLATE_NOT_PUBLISHED' }
    });
    const retained = await readJson<Record<string, unknown>>(
      member.context,
      `/api/nodes/${nodeId}/hosted-conversations/${memberConversation.id}`
    );
    expect(retained).toMatchObject({
      conversation: {
        id: memberConversation.id,
        activeVersionId: versionTwo,
        status: 'ACTIVE'
      },
      template: { status: 'DELETED', available: false }
    });
    memberWatch = await openWorkbenchWatch(browser, webUrl, member.cookie);
    await startHostedWatch(
      member,
      nodeId,
      memberConversation.id,
      memberWatch.connectionId,
      'hosted-e2e-member-watch-after-template-delete'
    );
    await waitForWatchFrame(
      memberWatch.page,
      (frame) =>
        frame.type === 'watch.event' &&
        record(frame.event)?.type === 'watch.hosted-conversation.snapshot' &&
        record(frame.event)?.conversationId === memberConversation.id
    );
    const requestsBeforeRetainedRun = modelRequests.length;
    await sendMessage(
      member,
      nodeId,
      memberConversation.id,
      modelId,
      'hosted-e2e-member-message-after-delete',
      '删除后保留轮'
    );
    await waitForSnapshot(
      member.context,
      nodeId,
      memberConversation.id,
      (snapshot) =>
        snapshot.conversation.activeVersionId === versionTwo &&
        JSON.stringify(snapshot).includes('Retained after delete reply')
    );
    await waitForWatchFrame(
      memberWatch.page,
      (frame) =>
        hostedWatchPayload(frame, memberConversation.id)?.kind === 'runtime' &&
        record(hostedWatchPayload(frame, memberConversation.id)?.runtimeEvent)?.kind === 'DELTA'
    );
    await waitForWatchFrame(
      memberWatch.page,
      (frame) =>
        hostedWatchPayload(frame, memberConversation.id)?.kind === 'run' &&
        record(hostedWatchPayload(frame, memberConversation.id)?.run)?.status === 'SUCCEEDED'
    );
    const retainedRunRequest = JSON.stringify(modelRequests.at(requestsBeforeRetainedRun));
    expect(retainedRunRequest).toContain('Use template version two.');
    expect(retainedRunRequest).not.toContain('Use template version three.');

    const beforeSwitch = await readJson<HostedConversationSnapshot>(
      admin.context,
      `/api/nodes/${nodeId}/hosted-conversations/${adminConversation.id}`
    );
    await writeFile(join(workspace, 'AGENTS.template.md'), 'Use the switched office template.\n');
    await writeFile(join(knowledge, 'guide.md'), 'switched template guide\n');
    const switchTarget = await writeJson<{ template: { id: string }; draft: { revision: number } }>(
      admin,
      'POST',
      '/api/admin/conversation-templates',
      { ...draft, name: 'Hosted E2E Switch Target' },
      201
    );
    const targetVersion = await publishTemplate(
      admin,
      switchTarget.template.id,
      switchTarget.draft.revision,
      'hosted-e2e-switch-publish',
      1
    );
    await writeJson(
      admin,
      'POST',
      `/api/nodes/${nodeId}/hosted-conversations/${adminConversation.id}/template`,
      { expectedTemplateId: templateId, templateId: switchTarget.template.id },
      403
    );
    await resources.createGrant(adminUserId, 'TEMPLATE', switchTarget.template.id, null, {
      targetType: 'ORGANIZATION',
      targetOrganizationId: rootOrganizationId
    });
    await startHostedWatch(
      admin,
      nodeId,
      adminConversation.id,
      adminWatch.connectionId,
      'hosted-e2e-template-switch-watch'
    );
    await waitForWatchFrame(
      adminWatch.page,
      (frame) =>
        frame.type === 'watch.event' &&
        record(frame.event)?.type === 'watch.hosted-conversation.snapshot' &&
        record(frame.event)?.watchId === 'hosted-e2e-template-switch-watch'
    );
    const switched = await writeJson<{
      conversation: { id: string; templateId: string; activeVersionId: string };
    }>(
      admin,
      'POST',
      `/api/nodes/${nodeId}/hosted-conversations/${adminConversation.id}/template`,
      { expectedTemplateId: templateId, templateId: switchTarget.template.id }
    );
    expect(switched.conversation).toMatchObject({
      id: adminConversation.id,
      templateId: switchTarget.template.id,
      activeVersionId: targetVersion
    });
    await waitForWatchFrame(
      adminWatch.page,
      (frame) => hostedWatchPayload(frame, adminConversation.id)?.kind === 'template-changed'
    );
    const afterSwitch = await readJson<HostedConversationSnapshot>(
      admin.context,
      `/api/nodes/${nodeId}/hosted-conversations/${adminConversation.id}`
    );
    expect(afterSwitch.turns).toEqual(beforeSwitch.turns);
    expect(afterSwitch.files).toEqual(beforeSwitch.files);
    const requestsBeforeSwitchedRun = modelRequests.length;
    await sendMessage(
      admin,
      nodeId,
      adminConversation.id,
      modelId,
      'hosted-e2e-switched-template-message',
      '验证切换模板'
    );
    const switchedRun = await waitForSnapshot(
      admin.context,
      nodeId,
      adminConversation.id,
      (snapshot) =>
        snapshot.conversation.templateId === switchTarget.template.id &&
        JSON.stringify(snapshot).includes('Switched template reply')
    );
    const switchedCommand = switchedRun.turns
      .flatMap((turn) => turn.items)
      .find(
        (item) =>
          item.kind === 'command_execution' && item.payload.command.includes('HOSTED_SWITCH_GUIDE')
      );
    expect(switchedCommand).toMatchObject({
      status: 'COMPLETED',
      payload: {
        exitCode: 0,
        output: {
          blocks: expect.arrayContaining([
            {
              channel: 'STDOUT',
              text: expect.stringContaining('HOSTED_SWITCH_GUIDE=switched template guide')
            }
          ])
        }
      }
    });
    expect(JSON.stringify(modelRequests.at(requestsBeforeSwitchedRun))).toContain(
      'Use the switched office template.'
    );
    const switchedDiskSessions = await expectUserDirectories(hostedRoot, [
      adminConversation.id,
      memberConversation.id
    ]);
    expect(switchedDiskSessions.get(adminConversation.id)).toEqual(adminDiskSession);

    const deleted = await writeJson<{ deletedConversationId: string }>(
      member,
      'DELETE',
      `/api/nodes/${nodeId}/hosted-conversations/${memberConversation.id}`,
      {}
    );
    expect(deleted).toEqual({ deletedConversationId: memberConversation.id });
    const deletedSnapshot = await member.context.get(
      `/api/nodes/${nodeId}/hosted-conversations/${memberConversation.id}`
    );
    expect(deletedSnapshot.status()).toBe(403);
    expect(await deletedSnapshot.json()).toMatchObject({
      error: { code: 'HOSTED_CONVERSATION_NOT_AUTHORIZED' }
    });
    const restoreAfterDelete = await member.context.post(
      `/api/nodes/${nodeId}/hosted-conversations/${memberConversation.id}/restore`,
      {
        headers: { 'x-csrf-token': member.csrfToken },
        data: {}
      }
    );
    expect(restoreAfterDelete.status()).toBe(404);
  } catch (error) {
    if (node !== undefined && node.output().length > 0)
      testInfo.attachments.push({
        name: 'hosted-node-output',
        contentType: 'text/plain',
        body: Buffer.from(node.output().slice(-20_000))
      });
    testInfo.attachments.push({
      name: 'hosted-model-requests',
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(modelRequests, undefined, 2))
    });
    throw error;
  } finally {
    await Promise.all([closeWorkbenchWatch(adminWatch), closeWorkbenchWatch(memberWatch)]);
    if (node !== undefined) await stopNodeConnector(node);
    await Promise.all([admin?.context.dispose(), member?.context.dispose()]);
    await database?.close();
    await server?.close();
    if (modelServer !== undefined)
      await new Promise<void>((resolve, reject) =>
        modelServer!.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
    await makeWritable(nodeData);
    await rm(nodeData, { recursive: true, force: true });
  }
});

function startNodeConnector(configPath: string, hostedImageSeed?: HostedImageSeed): NodeProcess {
  const source = `
    import { NodeConnector } from './mar-node/src/connector.ts';
    const hostedImageSeed = process.argv[2] === undefined
      ? undefined
      : JSON.parse(process.argv[2]);
    const connector = new NodeConnector({
      configPath: process.argv[1],
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: process.env.MAR_TEST_NODE_VERSION,
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: false },
        marAgent: { available: true, version: process.env.MAR_TEST_NODE_VERSION }
      },
      conversationHostingProbe: async () => ({ available: true, version: '0.11.1' }),
      reconnect: false
    });
    await connector.start();
    if (hostedImageSeed !== undefined) {
      const [image] = connector.runAttachmentService.registerNativeImages(
        hostedImageSeed.runId,
        [hostedImageSeed.root],
        [{
          name: hostedImageSeed.name,
          mime: hostedImageSeed.mime,
          localPath: hostedImageSeed.path
        }]
      );
      if (typeof image?.imageRef !== 'string') throw new Error('HOSTED_IMAGE_REF_MISSING');
      console.log('HOSTED_IMAGE_REF=' + image.imageRef);
    }
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await connector.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
  `;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      source,
      configPath,
      ...(hostedImageSeed === undefined ? [] : [JSON.stringify(hostedImageSeed)])
    ],
    {
      cwd: process.cwd(),
      env: {
        ...isolatedRunnerEnvironment(join(dirname(configPath), 'runner-home'), process.env),
        MAR_TEST_NODE_VERSION: (
          JSON.parse(readFileSync('mar-node/package.json', 'utf8')) as { version: string }
        ).version
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return { child, output: () => output };
}

async function stopNodeConnector(node: NodeProcess): Promise<void> {
  if (node.child.exitCode !== null) return;
  node.child.kill('SIGTERM');
  const exited = once(node.child, 'exit');
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      node.child.kill('SIGKILL');
      reject(new Error(`HOSTED_NODE_STOP_TIMEOUT\n${node.output().slice(-4_000)}`));
    }, 10_000);
    timer.unref();
  });
  await Promise.race([exited, timeout]);
}

function clearHostedConversationIndex(databasePath: string): void {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 5_000
  });
  try {
    // Simulate loss of the complete derived index without leaving orphaned child rows.
    database.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM conversation_files;
      DELETE FROM hosted_conversation_messages;
      DELETE FROM hosted_conversations;
      COMMIT;
    `);
  } finally {
    database.close();
  }
}

async function login(
  baseURL: string,
  username: string,
  currentPassword: string,
  password: string
): Promise<AuthenticatedContext> {
  const bootstrap = await playwrightRequest.newContext({ baseURL });
  const loginResponse = await bootstrap.post('/api/auth/login', {
    data: { username, password: currentPassword }
  });
  const loginBody = await expectJson<{ csrfToken: string }>(loginResponse, 200);
  const loginCookie = responseCookie(loginResponse);
  await bootstrap.dispose();
  const passwordContext = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { cookie: loginCookie }
  });
  const changed = await passwordContext.post('/api/auth/change-password', {
    headers: { 'x-csrf-token': loginBody.csrfToken },
    data: { currentPassword, password }
  });
  const changedBody = await expectJson<{ csrfToken: string }>(changed, 200);
  const changedCookie = responseCookie(changed);
  await passwordContext.dispose();
  const context = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { cookie: changedCookie }
  });
  return { context, csrfToken: changedBody.csrfToken, cookie: changedCookie };
}

async function openWorkbenchWatch(
  browser: Browser,
  baseURL: string,
  cookie: string
): Promise<WorkbenchWatchClient> {
  const separator = cookie.indexOf('=');
  if (separator <= 0) throw new Error('SESSION_COOKIE_INVALID');
  const context = await browser.newContext({ baseURL });
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      url: baseURL
    }
  ]);
  const page = await context.newPage();
  await page.route('**/*', (route) =>
    route.request().resourceType() === 'script' ? route.abort() : route.continue()
  );
  await page.goto('/console');
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __marHostedWatchFrames?: unknown[];
      __marHostedWatchSocket?: WebSocket;
    };
    state.__marHostedWatchFrames = [];
    const endpoint = new URL('/api/workbench/live', window.location.origin);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(endpoint);
    state.__marHostedWatchSocket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'resume' })));
    socket.addEventListener('message', (event) => {
      try {
        state.__marHostedWatchFrames!.push(JSON.parse(String(event.data)) as unknown);
      } catch {
        // The diagnostic client only records valid JSON Workbench frames.
      }
    });
    socket.addEventListener('close', (event) =>
      state.__marHostedWatchFrames!.push({
        type: 'socket.closed',
        code: event.code,
        reason: event.reason
      })
    );
    socket.addEventListener('error', () =>
      state.__marHostedWatchFrames!.push({ type: 'socket.error' })
    );
  });
  let ready: Record<string, unknown>;
  try {
    ready = await waitForWatchFrame(
      page,
      (frame) =>
        frame.type === 'workbench.ready' &&
        typeof frame.workbenchConnectionId === 'string' &&
        frame.resumed === false
    );
  } catch (error) {
    throw new Error(`HOSTED_WORKBENCH_READY_TIMEOUT\n${JSON.stringify(await watchFrames(page))}`, {
      cause: error
    });
  }
  return {
    context,
    page,
    connectionId: ready.workbenchConnectionId as string
  };
}

async function closeWorkbenchWatch(client: WorkbenchWatchClient | undefined): Promise<void> {
  if (client === undefined) return;
  await client.page
    .evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __marHostedWatchSocket?: WebSocket;
      };
      state.__marHostedWatchSocket?.close(1000, 'TEST_COMPLETE');
    })
    .catch(() => undefined);
  await client.context.close();
}

async function startHostedWatch(
  actor: AuthenticatedContext,
  nodeId: string,
  conversationId: string,
  workbenchConnectionId: string,
  watchId: string
): Promise<void> {
  await writeJson(
    actor,
    'POST',
    `/api/nodes/${nodeId}/hosted-conversations/${conversationId}/watch`,
    {
      mode: 'initial',
      workbenchConnectionId,
      watchId
    }
  );
}

async function waitForWatchFrame(
  page: Page,
  predicate: (frame: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  let selected: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const frames = await watchFrames(page);
        selected = frames.find((frame): frame is Record<string, unknown> => {
          const parsed = record(frame);
          return parsed !== undefined && predicate(parsed);
        });
        return selected !== undefined;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  if (selected === undefined) throw new Error('HOSTED_WORKBENCH_WATCH_FRAME_MISSING');
  return selected;
}

async function watchFrames(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __marHostedWatchFrames?: unknown[];
    };
    return state.__marHostedWatchFrames ?? [];
  });
}

function hostedWatchPayload(
  frame: Record<string, unknown>,
  conversationId: string
): Record<string, unknown> | undefined {
  if (frame.type !== 'watch.event') return undefined;
  const event = record(frame.event);
  if (event?.type !== 'watch.hosted-conversation.event' || event.conversationId !== conversationId)
    return undefined;
  const workbenchEvent = record(event.event);
  if (workbenchEvent?.category !== 'hosted-conversation') return undefined;
  return record(workbenchEvent.payload);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function waitForHostedNode(
  context: APIRequestContext,
  expectedNodeId?: string
): Promise<{ id: string; conversationHosting: unknown }> {
  let selected: { id: string; conversationHosting: unknown } | undefined;
  await expect
    .poll(
      async () => {
        const response = await context.get('/api/nodes');
        if (!response.ok()) return false;
        const body = (await response.json()) as {
          nodes?: Array<{
            id?: string;
            connected?: boolean;
            capabilities?: { conversationHosting?: { state?: string } };
          }>;
        };
        const node = body.nodes?.find(
          (candidate) =>
            candidate.connected === true &&
            (expectedNodeId === undefined || candidate.id === expectedNodeId)
        );
        if (typeof node?.id !== 'string') return false;
        selected = {
          id: node.id,
          conversationHosting: node.capabilities?.conversationHosting
        };
        return true;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  if (selected === undefined) throw new Error('HOSTED_NODE_NOT_CONNECTED');
  return selected;
}

async function publishTemplate(
  admin: AuthenticatedContext,
  templateId: string,
  draftRevision: number,
  requestId: string,
  expectedVersion: number
): Promise<string> {
  await writeJson(
    admin,
    'POST',
    `/api/admin/conversation-templates/${templateId}/publish`,
    { templateId, draftRevision, requestId },
    202
  );
  let versionId: string | null = null;
  await expect
    .poll(
      async () => {
        const response = await admin.context.get(
          `/api/admin/conversation-templates/${templateId}/publish-jobs/${requestId}`
        );
        if (!response.ok()) return false;
        const body = (await response.json()) as {
          job?: { status?: string; versionId?: string | null };
        };
        if (body.job?.status !== 'SUCCEEDED' || typeof body.job.versionId !== 'string')
          return false;
        versionId = body.job.versionId;
        return true;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  if (versionId === null) throw new Error('TEMPLATE_VERSION_NOT_PUBLISHED');
  const detail = await readJson<{
    template: { publishedVersion: number | null };
    versions: Array<{ version: number }>;
  }>(admin.context, `/api/admin/conversation-templates/${templateId}`);
  expect(detail.template.publishedVersion).toBe(expectedVersion);
  expect(detail.versions.map((item) => item.version)).toEqual(
    Array.from({ length: expectedVersion }, (_, index) => expectedVersion - index)
  );
  expect(detail).not.toHaveProperty('publishJobs');
  return versionId;
}

async function createConversation(
  actor: AuthenticatedContext,
  nodeId: string,
  templateId: string,
  clientRequestId: string
): Promise<{ id: string; activeVersionId: string; title: string; titleSource: string }> {
  const body = await writeJson<{
    conversation: {
      id: string;
      activeVersionId: string;
      title: string;
      titleSource: string;
    };
  }>(
    actor,
    'POST',
    `/api/nodes/${nodeId}/hosted-conversations`,
    {
      templateId,
      clientRequestId
    },
    201
  );
  return body.conversation;
}

async function sendMessage(
  actor: AuthenticatedContext,
  nodeId: string,
  conversationId: string,
  modelId: string,
  clientMessageId: string,
  prompt: string
): Promise<void> {
  await writeJson(
    actor,
    'POST',
    `/api/nodes/${nodeId}/hosted-conversations/${conversationId}/messages`,
    {
      clientMessageId,
      prompt,
      attachmentIds: [],
      modelId
    }
  );
}

async function expectOwnConversation(
  context: APIRequestContext,
  nodeId: string,
  ownConversationId: string,
  otherConversationId: string
): Promise<void> {
  const body = await readJson<{ items: Array<{ id: string }> }>(
    context,
    `/api/nodes/${nodeId}/hosted-conversations?limit=20`
  );
  expect(body.items.map((conversation) => conversation.id)).toContain(ownConversationId);
  expect(body.items.map((conversation) => conversation.id)).not.toContain(otherConversationId);
  const denied = await context.get(
    `/api/nodes/${nodeId}/hosted-conversations/${otherConversationId}`
  );
  expect(denied.ok()).toBe(false);
}

async function expectUserDirectories(
  hostedRoot: string,
  conversationIds: readonly string[]
): Promise<ReadonlyMap<string, HostedConversationDiskSession>> {
  const userDirectories = (
    await readdir(join(hostedRoot, 'users'), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory());
  expect(userDirectories).toHaveLength(2);
  const sessionsByConversation = new Map<string, HostedConversationDiskSession>();
  const sessionDirectories: string[] = [];
  for (const user of userDirectories) {
    const sessions = (
      await readdir(join(hostedRoot, 'users', user.name, 'sessions'), { withFileTypes: true })
    ).filter((entry) => entry.isDirectory());
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    if (session === undefined) throw new Error('HOSTED_SESSION_DIRECTORY_MISSING');
    sessionDirectories.push(session.name);
    const conversationDirectory = join(hostedRoot, 'users', user.name, 'sessions', session.name);
    const manifest = JSON.parse(
      await readFile(join(conversationDirectory, 'manifest', 'conversation.json'), 'utf8')
    ) as { readonly id?: unknown; readonly sessionId?: unknown };
    if (typeof manifest.id !== 'string' || typeof manifest.sessionId !== 'string')
      throw new Error('HOSTED_CONVERSATION_MANIFEST_INVALID');
    sessionsByConversation.set(manifest.id, {
      homeDirectory: await realpath(join(conversationDirectory, 'home')),
      sessionId: manifest.sessionId
    });
  }
  expect(
    new Set([...sessionsByConversation.values()].map((entry) => entry.homeDirectory)).size
  ).toBe(2);
  for (const conversationId of conversationIds)
    expect(sessionsByConversation.has(conversationId)).toBe(true);
  expect(
    conversationIds.every((conversationId) =>
      sessionDirectories.every((directory) => !directory.includes(conversationId))
    )
  ).toBe(true);
  return sessionsByConversation;
}

async function waitForSnapshot(
  context: APIRequestContext,
  nodeId: string,
  conversationId: string,
  predicate: (snapshot: HostedConversationSnapshot) => boolean
): Promise<HostedConversationSnapshot> {
  let snapshot: HostedConversationSnapshot | undefined;
  let lastResponse: { readonly status: number; readonly body: string } | undefined;
  try {
    await expect
      .poll(
        async () => {
          const response = await context.get(
            `/api/nodes/${nodeId}/hosted-conversations/${conversationId}`
          );
          const body = await response.text();
          if (!response.ok()) {
            lastResponse = { status: response.status(), body };
            return false;
          }
          snapshot = JSON.parse(body) as HostedConversationSnapshot;
          return predicate(snapshot);
        },
        { timeout: 60_000 }
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `HOSTED_SNAPSHOT_TIMEOUT\n${JSON.stringify({ snapshot, lastResponse }, undefined, 2)}`,
      { cause: error }
    );
  }
  if (snapshot === undefined) throw new Error('HOSTED_SNAPSHOT_MISSING');
  return snapshot;
}

async function waitForHostedFile(
  context: APIRequestContext,
  nodeId: string,
  conversationId: string,
  relativePath: string
): Promise<ConversationFileProjection> {
  let selected: ConversationFileProjection | undefined;
  await expect
    .poll(
      async () => {
        const response = await context.get(
          `/api/nodes/${nodeId}/hosted-conversations/${conversationId}/files`
        );
        if (!response.ok()) return false;
        const body = (await response.json()) as HostedConversationFiles;
        selected = body.files.find(
          (file) => file.category === 'OUTPUT' && file.relativePath === relativePath
        );
        return selected !== undefined;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  if (selected === undefined) throw new Error('HOSTED_CONVERSATION_OUTPUT_FILE_MISSING');
  return selected;
}

async function readJson<T>(context: APIRequestContext, url: string): Promise<T> {
  return expectJson<T>(await context.get(url), 200);
}

async function writeJson<T = unknown>(
  actor: AuthenticatedContext,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  data: unknown,
  expectedStatus = 200
): Promise<T> {
  const response = await actor.context.fetch(url, {
    method,
    headers: { 'x-csrf-token': actor.csrfToken },
    data
  });
  return expectJson<T>(response, expectedStatus);
}

async function writeNoContent(
  actor: AuthenticatedContext,
  method: 'POST' | 'DELETE',
  url: string,
  data: unknown
): Promise<void> {
  const response = await actor.context.fetch(url, {
    method,
    headers: { 'x-csrf-token': actor.csrfToken },
    data
  });
  expect(response.status(), await response.text()).toBe(204);
}

async function expectJson<T>(response: APIResponse, status: number): Promise<T> {
  const text = await response.text();
  expect(response.status(), text).toBe(status);
  return JSON.parse(text) as T;
}

function responseCookie(response: APIResponse): string {
  const value = response.headers()['set-cookie']?.split(';', 1)[0];
  if (value === undefined || value.length === 0) throw new Error('SESSION_COOKIE_REQUIRED');
  return value;
}
