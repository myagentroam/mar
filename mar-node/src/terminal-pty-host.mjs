import { spawn } from 'node-pty';
import { writeSync } from 'node:fs';
import { terminatePtyTree } from './terminal-pty-tree.mjs';

/** Owns exactly one native PTY. No replay, attachment or Node service state belongs here. */
let pty;
let finishing = false;
let stopping = false;
let orphaning = false;
const pipeWait = new Int32Array(new SharedArrayBuffer(4));

function output(data) {
  if (orphaning) return;
  const bytes = Buffer.from(data);
  let offset = 0;
  // Kernel backpressure blocks only this isolated host, not the main Node. Unlike
  // async stdout.write, it cannot accumulate an unbounded queue or run PTY exit
  // timers while output is paused. Interactive writes normally finish immediately.
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') Atomics.wait(pipeWait, 0, 0, 1);
      else {
        orphaned();
        return;
      }
    }
  }
}

function send(message, complete = () => {}) {
  if (process.connected) process.send(message, complete);
  else complete();
}

function finish(event) {
  if (finishing || orphaning) return;
  finishing = true;
  // Explicit exit also releases native addon threads/handles after normal PTY cleanup.
  // Synchronous output is already flushed; parent close joins the pipe before exit.
  send({ type: 'exit', event }, () => process.exit(0));
}

function stop() {
  if (stopping || finishing) return;
  stopping = true;
  // The parent has its own deadline even if a native kill blocks this event loop.
  try {
    if (pty === undefined) finish({ exitCode: 127 });
    else pty.kill();
  } catch {
    send({ type: 'error', code: 'TERMINAL_PTY_HOST_FAILED' });
    // Parent force-close owns final process-tree recovery.
  }
}

function orphaned() {
  if (finishing || orphaning) return;
  orphaning = true;
  stopping = true;
  // No synchronous addon call here: there is no parent left to enforce its deadline.
  void terminatePtyTree(pty?.pid).then(
    () => process.exit(0),
    () => process.exit(1)
  );
}

process.on('disconnect', orphaned);
process.on('SIGTERM', orphaned);
process.on('SIGINT', orphaned);
process.on('message', (message) => {
  if (finishing || orphaning) return;
  try {
    switch (message.type) {
      case 'start':
        pty = spawn(message.shell, message.args, message.options);
        // Keep draining native output, including its final chunks. Network backpressure
        // belongs to the main Node's existing bounded relay, not this local pipe.
        pty.onData(output);
        pty.onExit(finish);
        send({ type: 'started', pid: pty.pid });
        break;
      case 'input':
        if (!stopping) pty.write(message.data);
        break;
      case 'resize':
        if (!stopping) pty.resize(message.cols, message.rows);
        break;
      case 'kill':
        stop();
        break;
    }
  } catch {
    send({
      type: 'error',
      code: message.type === 'start' ? 'TERMINAL_PTY_START_FAILED' : 'TERMINAL_PTY_HOST_FAILED'
    });
    if (pty === undefined) finish({ exitCode: 127 });
    else stop();
  }
});
send({ type: 'ready' });
