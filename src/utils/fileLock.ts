import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface FileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_STALE_MS = 120000;
const LOCK_META_FILE = 'owner.json';

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function readLockOwner(lockDir: string): string {
  try {
    const raw = readFileSync(join(lockDir, LOCK_META_FILE), 'utf8');
    return raw;
  } catch {
    return '';
  }
}

function lockIsStale(lockDir: string, staleMs: number): boolean {
  try {
    const st = statSync(lockDir);
    return Date.now() - st.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function writeOwnerMetadata(lockDir: string): void {
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(lockDir, LOCK_META_FILE), JSON.stringify(owner), 'utf8');
}

export function withFileLockSync<T>(
  lockDir: string,
  fn: () => T,
  options?: FileLockOptions
): T {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options?.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lockDir, { recursive: false });
      writeOwnerMetadata(lockDir);
      break;
    } catch (error: any) {
      const code = error?.code;
      if (code !== 'EEXIST' && code !== 'EISDIR') {
        throw error;
      }

      if (existsSync(lockDir) && lockIsStale(lockDir, staleMs)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        const owner = readLockOwner(lockDir);
        const ownerSuffix = owner ? ` (owner=${owner})` : '';
        throw new Error(`Timed out waiting for lock ${lockDir}${ownerSuffix}`);
      }
      sleepSync(retryMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(join(lockDir, LOCK_META_FILE), { force: true });
    } catch {
      // Ignore best-effort cleanup.
    }
    try {
      rmdirSync(lockDir);
    } catch {
      // Ignore best-effort cleanup.
    }
  }
}
