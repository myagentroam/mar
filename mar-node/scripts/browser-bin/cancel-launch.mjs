// Only preloaded by an in-flight CLI launch. Forward cancellation to the
// pinned Playwright client's startup handler, including on Windows IPC.
let cancelled = false;
function cancelLaunch() {
  if (cancelled) return;
  cancelled = true;
  if (!process.emit('SIGTERM')) process.exit(1);
}

process.once('message', cancelLaunch);
process.once('disconnect', cancelLaunch);
process.channel?.unref();
