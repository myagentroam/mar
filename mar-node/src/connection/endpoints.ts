import { nodeCapabilitiesSchema, type NodeCapabilities } from '@myagentroam/protocol';

export function validatedCapabilities(value: unknown): NodeCapabilities {
  return nodeCapabilitiesSchema.parse(value);
}

export function nodeConnectEndpoint(serverUrl: string): string {
  const endpoint = new URL(serverUrl);
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('SERVER_URL_INVALID');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/node/connect`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

export function nodeTerminalConnectEndpoint(serverUrl: string): string {
  const endpoint = new URL(serverUrl);
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('SERVER_URL_INVALID');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/node/terminal-connect`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

export function nodeDesktopRelayEndpoint(serverUrl: string): string {
  const endpoint = new URL(serverUrl);
  if (endpoint.username || endpoint.password) throw new Error('SERVER_URL_INVALID');
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('SERVER_URL_INVALID');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/node/desktop-relay`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}
