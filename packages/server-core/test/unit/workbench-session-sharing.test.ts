import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as ClientWebSocket, type WebSocket as RelayWebSocket } from 'ws';
import type { SessionShareTarget, SessionShareVisitor } from '@myagentroam/protocol';
import {
  SESSION_SHARE_COOKIE,
  registerSessionShareRealtimeRoute
} from '../../src/session-share-routes.js';
import { SessionShares } from '../../src/session-shares.js';
import {
  WorkbenchRelayService,
  type ShareWorkbenchAccess
} from '../../src/workbench-relay-service.js';
import { sessionShareStore } from './support/session-share-store.js';
import { RelaySocket } from './support/relay-socket.js';

const target: SessionShareTarget = {
  nodeId: 'node-one',
  workspaceId: 'workspace-one',
  sessionId: 'session-one'
};

interface ParticipantFrame {
  readonly type: 'session-share.participants';
  readonly canRename: boolean;
  readonly sharerOnline: boolean;
  readonly participants: readonly SessionShareVisitor[];
}

function latestParticipants(socket: RelaySocket): ParticipantFrame | undefined {
  return socket.sent.filter((message) => message.type === 'session-share.participants').at(-1) as
    ParticipantFrame | undefined;
}

function relayFixture() {
  const relay = new WorkbenchRelayService({ database: { userOwnsNode: async () => true } });
  let serial = 0;
  const attachShare = (input: {
    readonly shareId: string;
    readonly ownerUserId: number;
    readonly target?: SessionShareTarget;
    readonly account?: { readonly userId: number; readonly name: string };
    readonly visitor: SessionShareVisitor;
  }) => {
    serial += 1;
    const socket = new RelaySocket();
    const access: ShareWorkbenchAccess = {
      shareId: input.shareId,
      ownerUserId: input.ownerUserId,
      ...(input.account === undefined ? {} : { account: input.account }),
      target: input.target ?? target,
      expiresAt: null,
      visitor: input.visitor,
      validate: async () => true
    };
    relay.attach(
      socket as unknown as RelayWebSocket,
      { userId: input.ownerUserId, sessionHash: 'share-session-' + serial },
      access
    );
    socket.receive({ type: 'resume' });
    return socket;
  };
  const attachWorkbench = (userId: number) => {
    serial += 1;
    const socket = new RelaySocket();
    relay.attach(socket as unknown as RelayWebSocket, {
      userId,
      sessionHash: 'workbench-session-' + serial
    });
    socket.receive({ type: 'resume' });
    return socket;
  };
  return { relay, attachShare, attachWorkbench };
}

const apps: ReturnType<typeof Fastify>[] = [];
const clients: ClientWebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Shared Session Workbench participant aggregation', () => {
  it('keeps anonymous and renamed visitors visible even when their browser is signed in as the sharer', () => {
    const { relay, attachShare } = relayFixture();
    try {
      const aa = attachShare({
        shareId: 'first-link',
        ownerUserId: 100,
        account: { userId: 100, name: 'admin' },
        visitor: { visitorId: 'browser-aa', name: 'aa' }
      });
      const bb = attachShare({
        shareId: 'second-link',
        ownerUserId: 100,
        account: { userId: 100, name: 'admin' },
        visitor: { visitorId: 'browser-bb' }
      });
      expect(latestParticipants(aa)).toMatchObject({
        sharerOnline: true,
        participants: [{ visitorId: 'browser-aa', name: 'aa' }, { visitorId: 'browser-bb' }]
      });
      expect(latestParticipants(bb)?.canRename).toBe(true);
      bb.receive({
        type: 'session-share.visitor',
        visitor: { visitorId: 'browser-bb', name: 'bb' }
      });
      expect(latestParticipants(aa)?.participants).toEqual([
        { visitorId: 'browser-aa', name: 'aa' },
        { visitorId: 'browser-bb', name: 'bb' }
      ]);
      expect(latestParticipants(bb)?.participants).toEqual(latestParticipants(aa)?.participants);
    } finally {
      relay.close();
    }
  });

  it('aggregates browser identities across links for one final target only', () => {
    const { relay, attachShare } = relayFixture();
    try {
      const observer = attachShare({
        shareId: 'observer-link',
        ownerUserId: 100,
        visitor: { visitorId: 'observer' }
      });
      attachShare({
        shareId: 'account-link-one',
        ownerUserId: 100,
        account: { userId: 44, name: 'Directory Name' },
        visitor: { visitorId: 'account-window-one', name: 'First Visitor' }
      });
      attachShare({
        shareId: 'account-link-two',
        ownerUserId: 100,
        account: { userId: 44, name: 'Directory Name' },
        visitor: { visitorId: 'account-window-two', name: 'Second Visitor' }
      });
      attachShare({
        shareId: 'visitor-link-one',
        ownerUserId: 100,
        visitor: { visitorId: 'guest-browser', name: 'Guest' }
      });
      attachShare({
        shareId: 'visitor-link-two',
        ownerUserId: 100,
        visitor: { visitorId: 'guest-browser', name: 'Guest' }
      });
      const otherSession = attachShare({
        shareId: 'other-session-link',
        ownerUserId: 100,
        target: { ...target, sessionId: 'session-two' },
        account: { userId: 44, name: 'Directory Name' },
        visitor: { visitorId: 'other-session-window' }
      });

      const frame = latestParticipants(observer)!;
      expect(frame.participants).toHaveLength(4);
      expect(frame.participants).toEqual(
        expect.arrayContaining([
          { visitorId: 'account-window-one', name: 'First Visitor' },
          { visitorId: 'account-window-two', name: 'Second Visitor' },
          { visitorId: 'guest-browser', name: 'Guest' },
          { visitorId: 'observer' }
        ])
      );
      expect(frame.participants.some((person) => person.name === 'Directory Name')).toBe(false);
      expect(frame.participants.some((person) => person.visitorId === 'other-session-window')).toBe(
        false
      );
      expect(latestParticipants(otherSession)?.participants).toEqual([
        { visitorId: 'other-session-window' }
      ]);
    } finally {
      relay.close();
    }
  });

  it('keeps each browser online across links until its last window closes', () => {
    const { relay, attachShare } = relayFixture();
    try {
      const observer = attachShare({
        shareId: 'observer-link',
        ownerUserId: 100,
        visitor: { visitorId: 'observer' }
      });
      const firstWindow = attachShare({
        shareId: 'account-link-one',
        ownerUserId: 100,
        account: { userId: 44, name: 'Account' },
        visitor: { visitorId: 'signed-in-browser', name: 'Visitor' }
      });
      const secondWindow = attachShare({
        shareId: 'account-link-two',
        ownerUserId: 100,
        account: { userId: 44, name: 'Account' },
        visitor: { visitorId: 'signed-in-browser', name: 'Visitor' }
      });
      const thirdWindow = attachShare({
        shareId: 'account-link-three',
        ownerUserId: 100,
        account: { userId: 44, name: 'Account' },
        visitor: { visitorId: 'signed-in-browser', name: 'Visitor' }
      });
      const guestWindowOne = attachShare({
        shareId: 'guest-link-one',
        ownerUserId: 100,
        visitor: { visitorId: 'same-guest', name: 'Guest' }
      });
      const guestWindowTwo = attachShare({
        shareId: 'guest-link-two',
        ownerUserId: 100,
        visitor: { visitorId: 'same-guest', name: 'Guest' }
      });
      const otherSession = attachShare({
        shareId: 'other-session-link',
        ownerUserId: 100,
        target: { ...target, sessionId: 'session-two' },
        account: { userId: 44, name: 'Account' },
        visitor: { visitorId: 'other-session-window' }
      });

      expect(latestParticipants(observer)?.participants).toHaveLength(3);
      firstWindow.close();
      guestWindowOne.close();
      expect(latestParticipants(observer)?.participants).toHaveLength(3);
      expect(latestParticipants(observer)?.participants).toEqual(
        expect.arrayContaining([
          { visitorId: 'signed-in-browser', name: 'Visitor' },
          { visitorId: 'same-guest', name: 'Guest' }
        ])
      );

      relay.invalidateShare('account-link-two', 'SESSION_SHARE_NOT_FOUND');
      expect(secondWindow.sent.at(-1)).toMatchObject({
        type: 'session-share.invalidated',
        code: 'SESSION_SHARE_NOT_FOUND'
      });
      expect(secondWindow.readyState).toBe(3);
      expect(observer.readyState).toBe(observer.OPEN);
      expect(latestParticipants(observer)?.participants).toHaveLength(3);
      thirdWindow.close();
      expect(latestParticipants(observer)?.participants).toEqual(
        expect.arrayContaining([{ visitorId: 'same-guest', name: 'Guest' }])
      );
      guestWindowTwo.close();
      expect(latestParticipants(observer)?.participants).toEqual([{ visitorId: 'observer' }]);
      expect(latestParticipants(otherSession)?.participants).toEqual([
        { visitorId: 'other-session-window' }
      ]);
    } finally {
      relay.close();
    }
  });

  it('uses verified accounts only for owner presence and accepts independent visitor names', () => {
    const { relay, attachShare, attachWorkbench } = relayFixture();
    try {
      attachWorkbench(100);
      const ownerLink = attachShare({
        shareId: 'owner-link',
        ownerUserId: 100,
        visitor: { visitorId: 'owner-link-viewer' }
      });
      expect(latestParticipants(ownerLink)?.sharerOnline).toBe(false);

      const ownerWindow = attachShare({
        shareId: 'owner-share-window',
        ownerUserId: 100,
        account: { userId: 100, name: 'Server Owner' },
        visitor: { visitorId: 'owner-window', name: 'Visitor Name' }
      });
      const peerLink = attachShare({
        shareId: 'peer-link',
        ownerUserId: 200,
        visitor: { visitorId: 'peer-viewer' }
      });

      expect(latestParticipants(ownerLink)?.sharerOnline).toBe(true);
      expect(latestParticipants(ownerLink)?.participants).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Server Owner' })])
      );
      expect(latestParticipants(peerLink)?.participants).toEqual(
        expect.arrayContaining([
          { visitorId: 'owner-window', name: 'Visitor Name' },
          { visitorId: 'peer-viewer' }
        ])
      );

      expect(latestParticipants(ownerWindow)?.canRename).toBe(true);
      expect(latestParticipants(ownerLink)?.canRename).toBe(true);
      ownerWindow.receive({
        type: 'session-share.visitor',
        visitor: { visitorId: 'owner-window', name: 'Renamed Visitor' }
      });
      expect(latestParticipants(peerLink)?.participants).toEqual(
        expect.arrayContaining([{ visitorId: 'owner-window', name: 'Renamed Visitor' }])
      );
      ownerWindow.receive({
        type: 'session-share.visitor',
        visitor: { visitorId: 'owner-window', name: 'Spoof', userId: 200 }
      });
      expect(ownerWindow.close).toHaveBeenCalledWith(4002, 'WORKBENCH_MESSAGE_INVALID');
      expect(latestParticipants(ownerLink)?.sharerOnline).toBe(false);
    } finally {
      relay.close();
    }
  });

  it('does not let visitor IDs or names impersonate the sharer online status', () => {
    const { relay, attachShare } = relayFixture();
    try {
      const observer = attachShare({
        shareId: 'owner-link',
        ownerUserId: 99,
        visitor: { visitorId: 'owner-link-viewer' }
      });
      const owner = attachShare({
        shareId: 'owner-window-link',
        ownerUserId: 99,
        account: { userId: 99, name: 'Verified Owner' },
        visitor: { visitorId: 'owner-window' }
      });
      attachShare({
        shareId: 'attacker-link',
        ownerUserId: 99,
        visitor: { visitorId: 'account:99', name: 'Visitor Impersonation' }
      });

      expect(latestParticipants(observer)?.sharerOnline).toBe(true);
      expect(latestParticipants(observer)?.participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ visitorId: 'account:99', name: 'Visitor Impersonation' })
        ])
      );
      owner.close();
      expect(latestParticipants(observer)?.sharerOnline).toBe(false);
      expect(latestParticipants(observer)?.participants).toContainEqual({
        visitorId: 'account:99',
        name: 'Visitor Impersonation'
      });
    } finally {
      relay.close();
    }
  });
});

describe('Session share realtime Cookie identity', () => {
  it('derives account identity from mar_user_session and ignores visitor identity claims', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);

    const { store, rows } = sessionShareStore();
    store.executionUser.mockResolvedValue({ username: 'directory-user', displayName: '  ' });
    const credential = 'A'.repeat(43);
    rows.set('share-one', {
      ...target,
      id: 'share-one',
      userId: 41,
      passwordHash: 'unused-in-this-route-test',
      password: null,
      credential,
      createdAt: Date.now(),
      expiresAt: null
    });
    const shares = new SessionShares({
      store,
      nodeControl: { requestNode: async () => ({}) },
      authorize: async () => true,
      invalidate: () => undefined
    });
    const attached: ShareWorkbenchAccess[] = [];
    registerSessionShareRealtimeRoute({
      app,
      database: {
        findCurrentUserSession: (id) =>
          id === 'account-session'
            ? {
                userId: 77,
                username: 'cookie-user',
                isAdmin: false,
                sessionHash: 'account-session-hash',
                mustChangePassword: false,
                csrfTokenHash: 'unused'
              }
            : undefined
      },
      shares,
      publicOrigin: 'http://localhost',
      attach: (_socket, _user, access) => attached.push(access)
    });
    await app.ready();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const websocketAddress = address.replace(/^http/u, 'ws');

    const connect = async (cookie: string) => {
      const socket = new ClientWebSocket(
        websocketAddress + '/api/session-shares/share-one/live?visitorId=account%3A41',
        { headers: { origin: 'http://localhost', cookie } }
      );
      clients.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('unexpected-response', (_request, response) => {
          reject(new Error('Unexpected HTTP ' + response.statusCode));
        });
      });
    };

    await connect(SESSION_SHARE_COOKIE + '=' + credential + '; mar_user_session=account-session');
    await connect(SESSION_SHARE_COOKIE + '=' + credential);

    expect(attached).toHaveLength(2);
    expect(attached[0]?.ownerUserId).toBe(41);
    expect(attached[0]?.visitor).toEqual({ visitorId: 'account:41' });
    expect(attached[0]?.account).toEqual({ userId: 77, name: 'directory-user' });
    expect(attached[1]?.account).toBeUndefined();
  });
});
