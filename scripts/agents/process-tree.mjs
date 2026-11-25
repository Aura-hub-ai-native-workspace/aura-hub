import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function installSignalAbort(controller, onSignal = () => {}) {
  const handles = new Map();
  let firstSignal = null;
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handle = () => {
      if (firstSignal) return;
      firstSignal = name;
      onSignal(name);
      controller.abort(new Error(`Interrupted by ${name}`));
    };
    process.on(name, handle);
    handles.set(name, handle);
  }
  return () => { for (const [name, handle] of handles) process.off(name, handle); };
}

function signalTree(child, force = false) {
  if (!child?.pid) return;
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], { stdio: 'ignore', windowsHide: true });
    try { child.kill(signal); } catch { /* already exited */ }
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already exited */ } }
}

export async function terminateProcessTree(child, graceMs = 200) {
  if (!child?.pid) return;
  signalTree(child);
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise((resolve) => child.once('close', resolve)), delay(graceMs)]);
  } else {
    await delay(graceMs);
  }
  signalTree(child, true);
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise((resolve) => child.once('close', resolve)), delay(1200)]);
  }
}

export function runProcess(bin, args, { cwd, env, timeoutMs, signal, maxChars = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      resolve({ bin, args, pid: null, stdout: '', stderr: '', exitCode: null, processError: error.code ?? error.message, timedOut: false, interrupted: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let processError = null;
    let timedOut = false;
    let interrupted = false;
    let finished = false;
    let childExited = false;
    let drainTimer;
    let forceTimer;
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-maxChars);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => { processError = error.code ?? error.message; });
    const finish = async (exitCode, exitSignal, drainTimedOut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      if (drainTimedOut) {
        signalTree(child, true);
        child.stdout.destroy();
        child.stderr.destroy();
      }
      await terminateProcessTree(child, 100);
      resolve({ bin, args, pid: child.pid, stdout, stderr, exitCode, signal: exitSignal, processError, timedOut, interrupted, drainTimedOut });
    };
    const stop = async (reason) => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'signal') interrupted = true;
      signalTree(child);
      if (childExited) signalTree(child, true);
      if (!finished) {
        forceTimer ??= setTimeout(() => {
          signalTree(child, true);
          child.stdout.destroy();
          child.stderr.destroy();
          void finish(child.exitCode, child.signalCode, true);
        }, 1500);
      }
    };
    const timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
    const abort = () => { void stop('signal'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('exit', (exitCode, exitSignal) => {
      childExited = true;
      // Detached descendants may inherit stdout/stderr and prevent `close`
      // indefinitely. Kill their process group, then bound the final drain.
      drainTimer = setTimeout(() => {
        signalTree(child, true);
        child.stdout.destroy();
        child.stderr.destroy();
        void finish(exitCode, exitSignal, true);
      }, 1200);
    });
    child.once('close', (exitCode, exitSignal) => { void finish(exitCode, exitSignal); });
  });
}
