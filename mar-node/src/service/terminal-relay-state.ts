export class TerminalRelayState {
  readonly attachments = new Map<
    string,
    { readonly attachmentId: string; readonly terminalId: string }
  >();
}
