import { RemoteDesktopClientError, type DesktopClientInput } from './remote-desktop-client-core.js';
import type { RemoteDesktopChannel } from './remote-desktop-channel.js';

type Attachment = {
  readonly channel: RemoteDesktopChannel;
  ready(): void;
  close(): Promise<boolean>;
};
type Client = {
  attach(input: DesktopClientInput): Promise<Attachment | undefined>;
  close(): void;
};
type Target = Omit<DesktopClientInput, 'signal'> & { readonly signal: AbortSignal };

/** Serializes one page's Direct/Relay replacements; it never owns an OS control lease. */
export function createRemoteDesktopPageAttachments(options: {
  readonly direct: Client;
  readonly relay: Client;
}) {
  let current: { handle: Attachment; closing?: Promise<boolean> } | undefined;
  let opening: AbortController | undefined;
  let sequence = 0;
  let unsafe = false;
  let disposed = false;
  let tail: Promise<void> = Promise.resolve();

  const error = () => new RemoteDesktopClientError('DESKTOP_CONTROL_UNAVAILABLE');
  function finalError(failure: unknown): unknown {
    if (
      !(failure instanceof RemoteDesktopClientError) ||
      !failure.confirmedCode ||
      failure.confirmedCode === failure.code
    )
      return failure;
    const result = new RemoteDesktopClientError(failure.confirmedCode);
    result.confirmedCode = failure.confirmedCode;
    result.settlement = failure.settlement;
    return result;
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
  function fence(record: NonNullable<typeof current>): Promise<boolean> {
    if (!record.closing) {
      try {
        record.closing = record.handle.close().catch(() => false);
      } catch {
        record.closing = Promise.resolve(false);
      }
    }
    return record.closing;
  }
  async function finish(record: NonNullable<typeof current>): Promise<boolean> {
    const settled = await fence(record).catch(() => false);
    if (!settled) unsafe = true;
    if (current === record) current = undefined;
    return settled;
  }
  function select(target: Target): Promise<Attachment> {
    const token = ++sequence;
    opening?.abort();
    if (current) void fence(current);
    return enqueue(async () => {
      if (current && !(await finish(current))) throw error();
      if (disposed || unsafe || token !== sequence || target.signal.aborted) throw error();
      const controller = new AbortController();
      opening = controller;
      const signal = AbortSignal.any([controller.signal, target.signal]);
      const input: DesktopClientInput = {
        ...target,
        signal,
        onDisconnected: (code) => {
          if (token === sequence && !disposed) target.onDisconnected(code);
        }
      };
      let handle: Attachment | undefined;
      try {
        try {
          handle = await options.direct.attach(input);
        } catch (failure) {
          const settled = failure instanceof RemoteDesktopClientError && (await failure.settlement);
          if (!settled) unsafe = true;
          if (
            !settled ||
            !(failure instanceof RemoteDesktopClientError) ||
            failure.confirmedCode !== 'DESKTOP_TRANSPORT_ERROR'
          )
            throw finalError(failure);
        }
        if (!handle && !signal.aborted && token === sequence) {
          try {
            handle = await options.relay.attach(input);
          } catch (failure) {
            if (!(failure instanceof RemoteDesktopClientError) || !(await failure.settlement))
              unsafe = true;
            throw finalError(failure);
          }
        }
        if (!handle) throw error();
        if (signal.aborted || token !== sequence || disposed) {
          if (!(await fence({ handle }))) unsafe = true;
          throw error();
        }
        const record = { handle };
        current = record;
        return {
          channel: handle.channel,
          ready: () => {
            if (current === record && token === sequence && !disposed) handle!.ready();
          },
          close: () => {
            if (current !== record) return fence(record);
            ++sequence;
            opening?.abort();
            void fence(record);
            return enqueue(() => finish(record));
          }
        };
      } finally {
        if (opening === controller) opening = undefined;
      }
    });
  }
  function close(): Promise<boolean> {
    ++sequence;
    opening?.abort();
    if (current) void fence(current);
    return enqueue(async () => {
      const settled = current ? await finish(current) : !unsafe;
      disposed = true;
      options.direct.close();
      options.relay.close();
      return settled;
    });
  }
  return { select, close };
}
