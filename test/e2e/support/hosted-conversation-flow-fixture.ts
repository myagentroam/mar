import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Unseals fixture-owned snapshots without following template symlinks. */
export async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata === undefined || metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
    return;
  }
  await chmod(path, 0o600);
}

export function templateDraft(nodeId: string, workspaceId: string, modelConfigId: string) {
  return {
    nodeId,
    workspaceId,
    name: 'Hosted E2E Template',
    description: 'Cross-module hosted conversation validation.',
    allowedModels: [{ modelId: modelConfigId, name: 'Hosted E2E' }],
    defaultModelId: modelConfigId,
    mcpIds: [],
    networkMode: 'NONE',
    quotas: {
      maxStorageBytes: 16 * 1024 * 1024,
      maxUploadBytes: 2 * 1024 * 1024
    }
  };
}

export async function startResponsesServer(
  requests: unknown[],
  workspace: string,
  tls?: { key: string; cert: string }
) {
  const sandboxHomeCallId = 'hosted-home-check-1';
  const outputWorkResumeCallId = 'hosted-output-work-resume-2';
  const generatedImageCopyCallId = 'hosted-generated-image-copy-1';
  const templateSwitchCallId = 'hosted-template-switch-check-1';
  const sourceGuide = shellQuote(join(workspace, 'knowledge', 'guide.md'));
  const sourceTool = shellQuote(join(workspace, '.venv', 'bin', 'template-tool'));
  const sourceOutput = shellQuote(join(workspace, 'output', 'alias-result.txt'));
  const sandboxHomeCommand =
    `test "$HOME" = /home/mar && ` +
    `test ! -e "$HOME/sdk-home-marker.txt" && ` +
    `test "$(cat ${sourceGuide})" = 'template version one' && ` +
    `address_limit="$(ulimit -v)" && ` +
    `case "$address_limit" in unlimited) ;; *[!0-9]*|'') exit 73 ;; *) test "$address_limit" -ge 4194304 ;; esac && ` +
    `printf 'alias output\\n' > ${sourceOutput} && ` +
    `printf 'first-run-progress\\n' > /tmp/progress.txt && ` +
    `printf 'HOSTED_SANDBOX_HOME=%s\\nSDK_SESSION_HOME_MARKER=hidden\\n' "$HOME" && ` +
    `printf 'HOSTED_ALIAS_GUIDE=%s\\n' "$(cat ${sourceGuide})" && ` +
    `printf 'HOSTED_TEMPLATE_TOOL=%s\\n' "$(${sourceTool})" && ` +
    `printf 'HOSTED_ADDRESS_LIMIT=%s\\n' "$address_limit" && ` +
    `printf 'ephemeral\\n' > "$HOME/sandbox-write-marker.txt"`;
  const handler: import('node:http').RequestListener = (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const parsed = JSON.parse(body) as unknown;
      requests.push(parsed);
      const serialized = JSON.stringify(parsed);
      const requestsTemplateSwitchCheck =
        serialized.includes('验证切换模板') &&
        serialized.includes('"name":"exec"') &&
        !serialized.includes(`"call_id":"${templateSwitchCallId}"`);
      const requestsSandboxHomeCheck =
        (serialized.includes('第一轮') || serialized.includes('release-smoke-tool')) &&
        serialized.includes('"name":"exec"') &&
        !serialized.includes(`"call_id":"${sandboxHomeCallId}"`);
      const generatedImagesLogicalPath =
        /\/home\/mar\/\.mar\/agent\/sessions\/[A-Za-z0-9._:-]+\/generated_images/u.exec(
          serialized
        )?.[0];
      const requestsGeneratedImageCopy =
        serialized.includes('复制之前生成的图片') &&
        serialized.includes('"name":"exec"') &&
        !serialized.includes(`"call_id":"${generatedImageCopyCallId}"`);
      const requestsOutputWorkResume =
        serialized.includes('第二轮') &&
        serialized.includes('"name":"exec"') &&
        !serialized.includes(`"call_id":"${outputWorkResumeCallId}"`);
      const outputWorkResumeCommand =
        `test "$(cat /tmp/progress.txt)" = 'first-run-progress' && ` +
        `printf 'HOSTED_OUTPUT_WORK_RESUME=ok\\n'`;
      const generatedImageCopyCommand =
        generatedImagesLogicalPath === undefined
          ? 'exit 71'
          : `test ! -e ${shellQuote(`${generatedImagesLogicalPath}/../private-session-marker.txt`)} && ` +
            `if printf 'changed\\n' > ${shellQuote(`${generatedImagesLogicalPath}/previous.png`)} 2>/dev/null; then exit 72; fi && ` +
            `cp ${shellQuote(`${generatedImagesLogicalPath}/previous.png`)} /workspace/output/copied-previous.png && ` +
            `cmp ${shellQuote(`${generatedImagesLogicalPath}/previous.png`)} /workspace/output/copied-previous.png && ` +
            `printf 'HOSTED_GENERATED_IMAGE_COPY=ok\\n'`;
      const toolCall = requestsGeneratedImageCopy
        ? {
            type: 'response.output_item.done',
            item: {
              id: `function-${requests.length}`,
              type: 'function_call',
              call_id: generatedImageCopyCallId,
              name: 'exec',
              arguments: JSON.stringify({
                action: 'start',
                command: generatedImageCopyCommand,
                yieldMs: 5_000
              })
            }
          }
        : requestsOutputWorkResume
          ? {
              type: 'response.output_item.done',
              item: {
                id: `function-${requests.length}`,
                type: 'function_call',
                call_id: outputWorkResumeCallId,
                name: 'exec',
                arguments: JSON.stringify({
                  action: 'start',
                  command: outputWorkResumeCommand,
                  yieldMs: 5_000
                })
              }
            }
          : requestsSandboxHomeCheck
            ? {
                type: 'response.output_item.done',
                item: {
                  id: `function-${requests.length}`,
                  type: 'function_call',
                  call_id: sandboxHomeCallId,
                  name: 'exec',
                  arguments: JSON.stringify({
                    action: 'start',
                    command: serialized.includes('release-smoke-tool')
                      ? `test "$HOME" = /home/mar && test -f /workspace/smoke.txt && printf 'RELEASE_HOSTED_SANDBOX_OK\\n'`
                      : sandboxHomeCommand,
                    yieldMs: 5_000
                  })
                }
              }
            : undefined;
      const text = serialized.includes('验证切换模板')
        ? 'Switched template reply'
        : serialized.includes('删除后保留轮')
          ? 'Retained after delete reply'
          : serialized.includes('成员恢复轮')
            ? 'Recovered member reply'
            : serialized.includes('第二轮')
              ? 'Second hosted reply'
              : serialized.includes('复制之前生成的图片')
                ? 'Copied previous generated image'
                : serialized.includes('第一轮')
                  ? 'First hosted reply'
                  : 'Hosted conversation';
      const requestNumber = requests.length;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          { type: 'response.created', response: { id: `response-${requestNumber}` } },
          ...(requestsTemplateSwitchCheck
            ? [
                {
                  type: 'response.output_item.done',
                  item: {
                    id: `function-${requests.length}`,
                    type: 'function_call',
                    call_id: templateSwitchCallId,
                    name: 'exec',
                    arguments: JSON.stringify({
                      action: 'start',
                      command: `test "$(cat ${sourceGuide})" = 'switched template guide' && test -f ${sourceOutput} && printf 'HOSTED_SWITCH_GUIDE=%s\\n' "$(cat ${sourceGuide})"`,
                      yieldMs: 5_000
                    })
                  }
                }
              ]
            : toolCall === undefined
              ? [
                  {
                    type: 'response.output_item.added',
                    item: {
                      id: `message-${requestNumber}`,
                      type: 'message',
                      role: 'assistant',
                      phase: 'final_answer'
                    }
                  },
                  {
                    type: 'response.output_text.delta',
                    item_id: `message-${requestNumber}`,
                    phase: 'final_answer',
                    delta: text
                  },
                  {
                    type: 'response.output_text.done',
                    item_id: `message-${requestNumber}`,
                    phase: 'final_answer',
                    text
                  }
                ]
              : [toolCall]),
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 10,
                output_tokens: 3,
                input_tokens_details: {}
              }
            }
          }
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      );
    });
  };
  const server = tls === undefined ? createServer(handler) : createHttpsServer(tls, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('FAKE_MODEL_UNAVAILABLE');
  return { server, baseUrl: `${tls === undefined ? 'http' : 'https'}://127.0.0.1:${address.port}` };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
