/** Terminates the native PTY shell and descendants without loading its native addon. */
export function terminatePtyTree(pid: number | undefined): Promise<void>;
