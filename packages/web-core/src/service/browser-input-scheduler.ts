import type { BrowserPageInput } from '@myagentroam/protocol';

type Point = { viewVersion: number; x: number; y: number };
type Motion =
  | Extract<BrowserPageInput, { type: 'move' }>
  | (Extract<BrowserPageInput, { type: 'touch' }> & { phase: 'move' });
type Scroll = { type: 'positioned-wheel'; point: Point; dx: number; dy: number };
type Continuous = Motion | Scroll;

const deltaLimit = 0xffff;
const bounded = (delta: number) => Math.max(-deltaLimit, Math.min(delta, deltaLimit));
const sameDirection = (a: number, b: number) => !a || !b || Math.sign(a) === Math.sign(b);
const version = (motion: Continuous) =>
  motion.type === 'positioned-wheel' ? motion.point.viewVersion : motion.viewVersion;
const samePoint = (a: Point | undefined, b: Point) =>
  a?.viewVersion === b.viewVersion && a.x === b.x && a.y === b.y;

/** Paces continuous input before it enters a reliable link. Keeps one trailing
 * sample, but never delays a press or a release behind the next animation frame. */
export class BrowserInputScheduler {
  private pending: Continuous | undefined;
  private frame: number | undefined;
  private pointer: Point | undefined;

  constructor(
    private readonly transmit: (action: BrowserPageInput) => boolean,
    private readonly clock = {
      request: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
      cancel: (id: number) => cancelAnimationFrame(id)
    }
  ) {}

  send(action: BrowserPageInput): boolean {
    if (action.type === 'move') return this.continuous(action);
    if (action.type === 'touch' && action.phase === 'move')
      return this.continuous({ ...action, phase: 'move' });
    this.flush(action.viewVersion);
    return this.forward(action);
  }

  wheel(point: Point, dx: number, dy: number): void {
    if ((dx || dy) && Number.isFinite(dx) && Number.isFinite(dy))
      this.continuous({ type: 'positioned-wheel', point, dx: bounded(dx), dy: bounded(dy) });
  }

  finish(viewVersion: number): void {
    this.flush(viewVersion);
  }

  reset(): void {
    this.pending = undefined;
    this.pointer = undefined;
    if (this.frame !== undefined) this.clock.cancel(this.frame);
    this.frame = undefined;
  }

  private continuous(action: Continuous): boolean {
    if (this.frame === undefined) {
      this.schedule();
      return this.dispatch(action);
    }
    const previous = this.pending;
    if (previous && version(previous) === version(action) && previous.type === action.type) {
      if (previous.type !== 'positioned-wheel') {
        this.pending = action;
        return true;
      }
      if (
        action.type === 'positioned-wheel' &&
        samePoint(previous.point, action.point) &&
        sameDirection(previous.dx, action.dx) &&
        sameDirection(previous.dy, action.dy) &&
        Math.abs(previous.dx + action.dx) <= deltaLimit &&
        Math.abs(previous.dy + action.dy) <= deltaLimit
      ) {
        previous.dx += action.dx;
        previous.dy += action.dy;
        return true;
      }
    }
    this.flush(version(action));
    this.pending = action;
    return true;
  }

  private schedule(): void {
    this.frame = this.clock.request(() => {
      this.frame = undefined;
      if (!this.pending) return;
      this.schedule();
      this.flush();
    });
  }

  private flush(viewVersion?: number): void {
    const action = this.pending;
    this.pending = undefined;
    if (action && (viewVersion === undefined || version(action) === viewVersion))
      this.dispatch(action);
  }

  private dispatch(action: Continuous): boolean {
    if (action.type !== 'positioned-wheel') return this.forward(action);
    // Use the existing ordered protocol so older Nodes receive the same target.
    if (!samePoint(this.pointer, action.point) && !this.forward({ type: 'move', ...action.point }))
      return false;
    return this.transmit({
      type: 'wheel',
      viewVersion: action.point.viewVersion,
      x: action.dx,
      y: action.dy
    });
  }

  private forward(action: BrowserPageInput): boolean {
    if (!this.transmit(action)) return false;
    if (action.type === 'move' || action.type === 'button') this.pointer = action;
    return true;
  }
}
