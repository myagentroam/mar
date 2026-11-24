const version = Buffer.from('RFB 003.008\n');
// 32 bpp, 24-bit true color, little-endian RGBX (noVNC's preferred format).
const rgbx = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
const serverInit = Buffer.alloc(24 + 15);
serverInit.writeUInt16BE(1, 0);
serverInit.writeUInt16BE(1, 2);
rgbx.copy(serverInit, 4);
serverInit.writeUInt32BE(15, 20);
serverInit.write('Browser Display', 24);

export const RFB_RAW = 0;
export const RFB_COPY_RECT = 1;
export const RFB_TIGHT = 7;
export const RFB_DESKTOP_SIZE = -223;

/** A read-only RFB 3.8 negotiation on an already authorized Browser attachment.
 * It never handles or forwards keyboard/clipboard messages, and holds at most
 * one framebuffer request. Pixel update credit is separate from negotiation.
 */
export class BrowserRfbPeer {
  private pending: Buffer = Buffer.alloc(0);
  private state: 'version' | 'security' | 'init' | 'running' = 'version';
  private available = false;
  private configured = false;
  private encodings = new Set<number>();

  constructor(
    private readonly reply: (bytes: Uint8Array) => void,
    private readonly request: () => void
  ) {}

  start(): void {
    this.reply(version);
  }

  receive(bytes: Buffer): void {
    if (!bytes.length || this.pending.length + bytes.length > 2048)
      throw new Error('Invalid RFB client message length.');
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    while (this.pending.length) {
      const input = this.pending;
      switch (this.state) {
        case 'version':
          if (input.length < version.length) return;
          if (!input.subarray(0, version.length).equals(version))
            throw new Error('Expected RFB 3.8.');
          this.pending = input.subarray(version.length);
          this.state = 'security';
          this.reply(Uint8Array.of(1, 1)); // None: the outer MAR protocol authenticated this peer.
          break;
        case 'security':
          if (input[0] !== 1) throw new Error('Invalid RFB security negotiation.');
          this.pending = input.subarray(1);
          this.state = 'init';
          this.reply(new Uint8Array(4));
          break;
        case 'init':
          if (input[0]! > 1) throw new Error('Invalid RFB client init.');
          this.pending = input.subarray(1);
          this.state = 'running';
          this.reply(serverInit);
          break;
        case 'running':
          if (!this.message(input)) return;
      }
    }
  }

  get requested(): boolean {
    return this.available;
  }

  supports(encoding: number): boolean {
    return this.encodings.has(encoding);
  }

  get supportsJpeg(): boolean {
    return (
      this.supports(RFB_TIGHT) &&
      [...this.encodings].some((encoding) => encoding >= -32 && encoding <= -23)
    );
  }

  consume(): void {
    this.available = false;
  }

  private message(input: Buffer): boolean {
    switch (input[0]) {
      case 0: {
        if (input.length < 20) return false;
        const format = input.subarray(4, 17);
        if (!format.equals(rgbx.subarray(0, 13))) throw new Error('Unsupported RFB pixel format.');
        this.pending = input.subarray(20);
        break;
      }
      case 2: {
        if (input.length < 4) return false;
        const count = input.readUInt16BE(2);
        if (count > 64) throw new Error('Too many RFB encodings.');
        if (input.length < 4 + count * 4) return false;
        this.encodings = new Set(
          Array.from({ length: count }, (_, i) => input.readInt32BE(4 + i * 4))
        );
        if (!this.supports(RFB_DESKTOP_SIZE)) throw new Error('RFB DesktopSize is required.');
        this.configured = true;
        this.pending = input.subarray(4 + count * 4);
        break;
      }
      case 3:
        if (input.length < 10) return false;
        if (!this.configured || input[1]! > 1) throw new Error('Unexpected framebuffer request.');
        this.pending = input.subarray(10);
        this.available = true;
        this.request();
        break;
      default:
        throw new Error('Unsupported RFB client message.');
    }
    return true;
  }
}
