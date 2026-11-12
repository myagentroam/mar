import { describe, expect, it } from 'vitest';
import {
  remoteDesktopAttachedFrameSchema,
  remoteDesktopCapabilitySchema,
  remoteDesktopDescriptionSchema,
  remoteDesktopDescribeInputSchema,
  remoteDesktopDirectBrowserMessageSchema,
  remoteDesktopDirectNodeCommandSchema,
  remoteDesktopDirectNodeEventSchema,
  remoteDesktopDirectOpenFrameSchema,
  remoteDesktopDirectServerMessageSchema,
  remoteDesktopRelayBrowserAttachSchema,
  remoteDesktopRelayBrowserMessageSchema,
  remoteDesktopRelayNodeAttachSchema,
  remoteDesktopRelayNodeCommandSchema,
  remoteDesktopRelayNodeEventSchema,
  remoteDesktopRelayServerMessageSchema
} from '../../src/remote-desktop.js';

const id = 'abcdefgh';
describe('single-display capture discovery', () => {
  it('accepts one display or capture generation selector and rejects ambiguous or unbounded input', () => {
    for (const input of [{}, { displayId: 'display_2' }, { desktopGeneration: id }])
      expect(remoteDesktopDescribeInputSchema.safeParse(input).success).toBe(true);
    for (const input of [
      { displayId: 'display_2', desktopGeneration: id },
      { displayId: '../../display' },
      { host: 'localhost' }
    ])
      expect(remoteDesktopDescribeInputSchema.safeParse(input).success).toBe(false);
  });
  it('keeps the physical display catalog separate from the selected capture surface', () => {
    const selected = {
      desktopGeneration: id,
      topologyRevision: 1,
      framebuffer: { width: 640, height: 480 },
      displays: [
        {
          displayId: 'display_2',
          name: 'Secondary',
          primary: true,
          nativeBounds: { x: -640, y: 0, width: 640, height: 480 },
          framebufferBounds: { x: 0, y: 0, width: 640, height: 480 },
          nativeToFramebuffer: [1, 0, 0, 1, 640, 0]
        }
      ],
      selectableDisplays: [
        { displayId: 'display_1', name: 'Primary', primary: true },
        { displayId: 'display_2', name: 'Secondary', primary: false }
      ]
    };
    expect(remoteDesktopDescriptionSchema.safeParse(selected).success).toBe(true);
    for (const selectableDisplays of [
      [],
      [selected.selectableDisplays[0]],
      [selected.selectableDisplays[1]],
      [selected.selectableDisplays[0], selected.selectableDisplays[0]]
    ])
      expect(
        remoteDesktopDescriptionSchema.safeParse({ ...selected, selectableDisplays }).success
      ).toBe(false);
  });
});
describe('desktop browser settlement', () => {
  it('distinguishes settled from closed and rejects foreign fields', () => {
    for (const [path, schema] of [
      ['direct', remoteDesktopDirectServerMessageSchema],
      ['relay', remoteDesktopRelayServerMessageSchema]
    ] as const) {
      expect(
        schema.safeParse({
          type: `desktop.${path}.settled`,
          attachmentId: id,
          code: 'DESKTOP_CLOSED'
        }).success
      ).toBe(true);
      expect(schema.safeParse({ type: `desktop.${path}.settled`, attachmentId: id }).success).toBe(
        false
      );
      expect(
        schema.safeParse({
          type: `desktop.${path}.settled`,
          attachmentId: id,
          code: 'DESKTOP_CLOSED',
          extra: true
        }).success
      ).toBe(false);
      expect(schema.safeParse({ type: `desktop.${path}.closed`, attachmentId: id }).success).toBe(
        false
      );
    }
  });
});
const prepare = {
  type: 'desktop.direct.prepare',
  requestId: id,
  nodeId: 'node-a',
  nodeGeneration: id,
  transportSessionId: id,
  desktopGeneration: id,
  topologyRevision: 1,
  mode: 'VIEW'
};
const fingerprint = `sha-256 ${Array.from({ length: 32 }, () => 'AB').join(':')}`;

describe('remote desktop authorization envelope', () => {
  it('binds relay control and one-time socket handoffs without an arbitrary target', () => {
    const ticket = 'a'.repeat(43);
    const relay = {
      type: 'desktop.relay.prepare',
      requestId: id,
      nodeId: 'node-a',
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: 1,
      mode: 'VIEW'
    };
    expect(remoteDesktopRelayBrowserMessageSchema.safeParse(relay).success).toBe(true);
    expect(
      remoteDesktopRelayBrowserMessageSchema.safeParse({ ...relay, url: 'ws://other' }).success
    ).toBe(false);
    const browser = {
      type: 'desktop.relay.browser',
      attachmentId: id,
      workbenchConnectionId: id,
      ticket
    };
    expect(remoteDesktopRelayBrowserAttachSchema.safeParse(browser).success).toBe(true);
    expect(
      remoteDesktopRelayBrowserAttachSchema.safeParse({ ...browser, credential: 'secret' }).success
    ).toBe(false);
    const node = {
      type: 'desktop.relay.node',
      nodeId: 'node-a',
      nodeGeneration: id,
      attachmentId: id,
      ticket,
      credential: 'secret'
    };
    expect(remoteDesktopRelayNodeAttachSchema.safeParse(node).success).toBe(true);
    expect(remoteDesktopRelayNodeAttachSchema.safeParse({ ...node, ticket: 'short' }).success).toBe(
      false
    );
    expect(remoteDesktopRelayNodeAttachSchema.safeParse({ ...node, extra: true }).success).toBe(
      false
    );
    expect(
      remoteDesktopRelayNodeCommandSchema.safeParse({
        type: 'desktop.relay.prepare',
        attachmentId: id,
        workbenchConnectionId: id,
        nodeGeneration: id,
        desktopGeneration: id,
        topologyRevision: 1,
        mode: 'VIEW',
        grant: ticket,
        ticket,
        openExpiresAt: 1,
        expiresAt: 2
      }).success
    ).toBe(true);
    expect(
      remoteDesktopRelayNodeEventSchema.safeParse({
        type: 'desktop.relay.ready',
        attachmentId: id,
        nodeGeneration: id,
        phase: 'OPEN'
      }).success
    ).toBe(true);
    expect(
      remoteDesktopRelayServerMessageSchema.safeParse({
        type: 'desktop.relay.prepared',
        requestId: id,
        attachmentId: id,
        grant: ticket,
        ticket,
        openExpiresAt: 1,
        expiresAt: 2
      }).success
    ).toBe(true);
  });
  it('accepts only bounded Node lifecycle events and known phases', () => {
    for (const phase of ['PREPARED', 'OPEN', 'ATTACHED', 'ACTIVE']) {
      expect(
        remoteDesktopDirectNodeEventSchema.safeParse({
          type: 'desktop.direct.ready',
          attachmentId: id,
          nodeGeneration: id,
          phase
        }).success
      ).toBe(true);
    }
    for (const event of [
      { type: 'desktop.direct.ready', attachmentId: id, phase: 'OPEN' },
      { type: 'desktop.direct.ready', attachmentId: id, nodeGeneration: id, phase: 'CLOSING' },
      {
        type: 'desktop.direct.ready',
        attachmentId: id,
        nodeGeneration: id,
        phase: 'OPEN',
        grant: 'secret'
      },
      { type: 'desktop.direct.closed', attachmentId: id, nodeGeneration: id, code: 'invalid' },
      {
        type: 'desktop.direct.closed',
        attachmentId: id,
        nodeGeneration: id,
        code: 'DESKTOP_CLOSED',
        phase: 'ACTIVE'
      }
    ])
      expect(remoteDesktopDirectNodeEventSchema.safeParse(event).success).toBe(false);
    expect(
      remoteDesktopDirectNodeEventSchema.safeParse({
        type: 'desktop.direct.closed',
        attachmentId: id,
        nodeGeneration: id,
        code: 'DESKTOP_CLOSED'
      }).success
    ).toBe(true);
  });
  it('describes negative native coordinates and mixed scale with explicit framebuffer mappings', () => {
    const description = {
      desktopGeneration: id,
      topologyRevision: 2,
      framebuffer: { width: 3840, height: 1080 },
      displays: [
        {
          displayId: 'displaya',
          name: 'Secondary',
          primary: false,
          nativeBounds: { x: -960, y: 0, width: 960, height: 540 },
          framebufferBounds: { x: 0, y: 0, width: 1920, height: 1080 },
          nativeToFramebuffer: [2, 0, 0, 2, 1920, 0]
        },
        {
          displayId: 'displayb',
          name: 'Primary',
          primary: true,
          nativeBounds: { x: 0, y: 0, width: 1920, height: 1080 },
          framebufferBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
          nativeToFramebuffer: [1, 0, 0, 1, 1920, 0]
        }
      ]
    };
    expect(remoteDesktopDescriptionSchema.safeParse(description).success).toBe(true);
    expect(
      remoteDesktopDescriptionSchema.safeParse({
        ...description,
        displays: [description.displays[0]]
      }).success
    ).toBe(false);
    expect(
      remoteDesktopDescriptionSchema.safeParse({
        ...description,
        displays: [
          description.displays[0],
          { ...description.displays[1], nativeToFramebuffer: [1, 0, 0, 1, 0, 0] }
        ]
      }).success
    ).toBe(false);
    expect(
      remoteDesktopDescriptionSchema.safeParse({
        ...description,
        displays: [description.displays[0], { ...description.displays[1], displayId: 'displaya' }]
      }).success
    ).toBe(false);
  });

  it('accepts rotated and mirrored native mappings but rejects singular transforms', () => {
    const display = {
      displayId: 'displaya',
      name: 'Rotated',
      primary: true,
      nativeBounds: { x: 0, y: 0, width: 600, height: 800 },
      framebufferBounds: { x: 0, y: 0, width: 800, height: 600 },
      nativeToFramebuffer: [0, 1, -1, 0, 800, 0]
    };
    const description = {
      desktopGeneration: id,
      topologyRevision: 1,
      framebuffer: { width: 800, height: 600 },
      displays: [display]
    };
    expect(remoteDesktopDescriptionSchema.safeParse(description).success).toBe(true);
    expect(
      remoteDesktopDescriptionSchema.safeParse({
        ...description,
        displays: [{ ...display, nativeToFramebuffer: [0, 1, 1, 0, 0, 0] }]
      }).success
    ).toBe(true);
    expect(
      remoteDesktopDescriptionSchema.safeParse({
        ...description,
        displays: [{ ...display, nativeToFramebuffer: [0, 0, 0, 0, 0, 0] }]
      }).success
    ).toBe(false);
  });

  it('accepts a generation-bound prepare without workspace or network targets', () => {
    expect(remoteDesktopDirectBrowserMessageSchema.safeParse(prepare).success).toBe(true);
    expect(
      remoteDesktopDirectBrowserMessageSchema.safeParse({ ...prepare, mode: 'CONTROL' }).success
    ).toBe(true);
    for (const extra of [
      { workspaceId: 'workspace' },
      { host: '127.0.0.1' },
      { socketPath: '/tmp/vnc' },
      { mode: 'WRITE' },
      { topologyRevision: Number.MAX_SAFE_INTEGER + 1 }
    ])
      expect(
        remoteDesktopDirectBrowserMessageSchema.safeParse({ ...prepare, ...extra }).success
      ).toBe(false);
  });

  it('requires both authenticated transport fingerprints and a bounded grant', () => {
    const command = {
      type: 'desktop.direct.prepare',
      attachmentId: id,
      transportSessionId: id,
      workbenchConnectionId: id,
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: 1,
      mode: 'CONTROL',
      grant: 'x'.repeat(32),
      browserFingerprint: fingerprint,
      nodeFingerprint: fingerprint,
      openExpiresAt: 100,
      expiresAt: 200
    };
    expect(remoteDesktopDirectNodeCommandSchema.safeParse(command).success).toBe(true);
    expect(
      remoteDesktopDirectNodeCommandSchema.safeParse({ ...command, nodeFingerprint: 'untrusted' })
        .success
    ).toBe(false);
    expect(
      remoteDesktopDirectNodeCommandSchema.safeParse({ ...command, grant: 'short' }).success
    ).toBe(false);
  });

  it('does not add an alternative pixel or input protocol', () => {
    expect(
      remoteDesktopDirectBrowserMessageSchema.safeParse({ type: 'desktop.ready', attachmentId: id })
        .success
    ).toBe(true);
    expect(
      remoteDesktopDirectBrowserMessageSchema.safeParse({
        type: 'desktop.input',
        attachmentId: id,
        data: 'x'
      }).success
    ).toBe(false);
    expect(
      remoteDesktopAttachedFrameSchema.safeParse({ type: 'ATTACHED', attachmentId: id }).success
    ).toBe(true);
    expect(
      remoteDesktopDirectOpenFrameSchema.safeParse({
        type: 'OPEN',
        attachmentId: id,
        grant: 'x'.repeat(32)
      }).success
    ).toBe(true);
    expect(
      remoteDesktopDirectOpenFrameSchema.safeParse({
        type: 'OPEN',
        attachmentId: id,
        grant: 'x'.repeat(32),
        host: 'localhost'
      }).success
    ).toBe(false);
  });

  it('bounds errors and capability projection without pretending unavailable platforms work', () => {
    expect(
      remoteDesktopCapabilitySchema.safeParse({
        apiVersion: 1,
        available: false,
        nodeGeneration: 'generation-1',
        reasonCode: 'DESKTOP_UNAVAILABLE'
      }).success
    ).toBe(true);
    const available = {
      apiVersion: 1,
      available: true,
      nodeGeneration: 'generation-1',
      backend: 'TIGERVNC_X0',
      supportsView: true,
      supportsControl: true,
      supportsMultiDisplay: true,
      supportsUnicodePaste: true,
      transports: ['DIRECT', 'RELAY']
    };
    expect(remoteDesktopCapabilitySchema.safeParse(available).success).toBe(true);
    expect(
      remoteDesktopCapabilitySchema.safeParse({ ...available, nodeGeneration: undefined }).success
    ).toBe(false);
    expect(
      remoteDesktopCapabilitySchema.safeParse({ ...available, transports: ['DIRECT', 'DIRECT'] })
        .success
    ).toBe(false);
    expect(
      remoteDesktopCapabilitySchema.safeParse({ ...available, maxAttachments: 100 }).success
    ).toBe(false);
    expect(
      remoteDesktopDirectServerMessageSchema.safeParse({
        type: 'desktop.direct.error',
        code: 'DESKTOP_TOPOLOGY_UNAVAILABLE',
        message: 'Desktop control is already held.'
      }).success
    ).toBe(true);
    expect(
      remoteDesktopDirectServerMessageSchema.safeParse({
        type: 'desktop.direct.error',
        code: 'bad',
        message: ''
      }).success
    ).toBe(false);
  });
});
