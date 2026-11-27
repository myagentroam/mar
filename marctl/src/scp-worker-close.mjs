/** Stop the built-in copy worker without flushing buffered copy data after cancellation. */
export async function closeScpWorker(child, closed) {
  // EOF lets the worker discard its unpublished temporary file on all platforms.
  child.stdin.destroy();
  child.stdout.resume();
  child.stderr.resume();
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}
