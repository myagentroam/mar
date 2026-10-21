import {
  computerUseDisableInputSchema,
  computerUseEnableInputSchema,
  computerUseEnableResultSchema,
  type ComputerUseCapability
} from '@myagentroam/protocol';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createComputerUseEnablementService(request: Request): {
  enable(nodeId: string): Promise<ComputerUseCapability>;
  disable(nodeId: string): Promise<ComputerUseCapability>;
} {
  const change = async (
    nodeId: string,
    action: 'enable' | 'disable'
  ): Promise<ComputerUseCapability> => {
    const body =
      action === 'enable'
        ? computerUseEnableInputSchema.parse({ enabled: true })
        : computerUseDisableInputSchema.parse({});
    const response = await request<unknown>(
      `/api/management/nodes/${encodeURIComponent(nodeId)}/computer-use/${action}`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    return computerUseEnableResultSchema.parse(response).capability;
  };
  return {
    enable: (nodeId) => change(nodeId, 'enable'),
    disable: (nodeId) => change(nodeId, 'disable')
  };
}
