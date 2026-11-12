import { remoteDesktopCapabilitySchema } from '@myagentroam/protocol';

export function publicNode<
  T extends {
    readonly id: string;
    readonly metadata: string;
    readonly connected: boolean;
    readonly disabled: boolean;
    readonly lastHeartbeatAt: number | null;
  }
>(node: T) {
  let metadata: unknown = {};
  try {
    const parsedMetadata: unknown = JSON.parse(node.metadata);
    if (
      typeof parsedMetadata === 'object' &&
      parsedMetadata !== null &&
      !Array.isArray(parsedMetadata)
    )
      metadata = parsedMetadata;
  } catch {
    // Corrupt persisted metadata does not leak an internal database error.
  }
  const info = metadata as Record<string, unknown>;
  const desktop = remoteDesktopCapabilitySchema.safeParse(info['remoteDesktop']);
  return {
    ...node,
    platform: typeof info['platform'] === 'string' ? info['platform'] : 'unknown',
    architecture: typeof info['architecture'] === 'string' ? info['architecture'] : 'unknown',
    nodeAppVersion: typeof info['nodeAppVersion'] === 'string' ? info['nodeAppVersion'] : 'unknown',
    nodeVersion: typeof info['nodeVersion'] === 'string' ? info['nodeVersion'] : 'unknown',
    capabilities: {
      ...(typeof info['codex'] === 'object' && info['codex'] !== null
        ? { codex: info['codex'] }
        : {}),
      ...(typeof info['claudeCode'] === 'object' && info['claudeCode'] !== null
        ? { claudeCode: info['claudeCode'] }
        : {}),
      ...(typeof info['openCode'] === 'object' && info['openCode'] !== null
        ? { openCode: info['openCode'] }
        : {}),
      ...(typeof info['marAgent'] === 'object' && info['marAgent'] !== null
        ? { marAgent: info['marAgent'] }
        : {}),
      ...(typeof info['marAgentRuntimeCredentials'] === 'object' &&
      info['marAgentRuntimeCredentials'] !== null
        ? { marAgentRuntimeCredentials: info['marAgentRuntimeCredentials'] }
        : {}),
      ...(typeof info['chatgptLogin'] === 'object' && info['chatgptLogin'] !== null
        ? { chatgptLogin: info['chatgptLogin'] }
        : {}),
      ...(typeof info['promptCompletion'] === 'object' && info['promptCompletion'] !== null
        ? { promptCompletion: info['promptCompletion'] }
        : {}),
      ...(typeof info['conversationHosting'] === 'object' && info['conversationHosting'] !== null
        ? { conversationHosting: info['conversationHosting'] }
        : {}),
      ...(typeof info['computerUse'] === 'object' && info['computerUse'] !== null
        ? { computerUse: info['computerUse'] }
        : {}),
      ...(desktop.success ? { remoteDesktop: desktop.data } : {})
    },
    metadata: info
  };
}
