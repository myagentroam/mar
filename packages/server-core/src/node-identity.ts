export interface StoredNode {
  readonly id: string;
  readonly ownerUserId: number;
  readonly displayName: string | null;
  /** Address observed on the initial Node control socket. */
  readonly registeredAddress: string;
  readonly metadata: string;
  readonly disabled: boolean;
  readonly lastHeartbeatAt: number | null;
}

export interface NodeIdentityStore {
  registerNode(
    token: string,
    input: { readonly metadata: string },
    registeredAddress?: string
  ):
    | { nodeId: string; credential: string }
    | undefined
    | Promise<{ nodeId: string; credential: string } | undefined>;
  authenticateNode(
    nodeId: string,
    credential: string
  ): StoredNode | undefined | Promise<StoredNode | undefined>;
  updateNodeHeartbeat(
    nodeId: string,
    capabilities?: { readonly metadata: string }
  ): void | Promise<void>;
}
