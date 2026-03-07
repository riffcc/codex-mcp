import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { withFileLockSync } from './fileLock.js';
import { Logger } from './logger.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobUpdate {
  seq: number;
  timestamp: string;
  message: string;
}

export interface AsyncJob {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  updates: JobUpdate[];
  result?: string;
  error?: string;
  threadId?: string;
  metadata?: Record<string, string | number | boolean>;
}

interface JobSnapshot {
  job: AsyncJob;
  updates: JobUpdate[];
  latestSeq: number;
}

interface PersistedJobs {
  version: 1;
  jobs: AsyncJob[];
}

export interface JobRunResult {
  result: string;
  threadId?: string;
  metadata?: Record<string, string | number | boolean>;
}

const jobs = new Map<string, AsyncJob>();
const waiters = new Map<string, Array<() => void>>();

const MAX_JOBS = 200;
const MAX_UPDATES_PER_JOB = 500;
const PRIMARY_JOB_STORE_DIR = join(homedir(), '.codex-mcp-server');
const FALLBACK_JOB_STORE_DIR = join(tmpdir(), 'codex-mcp-server');
let activeJobStoreDir = PRIMARY_JOB_STORE_DIR;
let JOB_STORE_FILE = join(activeJobStoreDir, 'jobs.json');
let JOB_STORE_LOCK_DIR = join(activeJobStoreDir, 'jobs.lock');

let persistTimer: NodeJS.Timeout | undefined;

function nowIso(): string {
  return new Date().toISOString();
}

function getHeartbeatIntervalMs(): number {
  const raw = Number(process.env.CODEX_MCP_JOB_HEARTBEAT_MS || 30000);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
}

function getRunningJobStaleMs(): number {
  const raw = Number(process.env.CODEX_MCP_RUNNING_JOB_STALE_MS || 0);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return Math.max(getHeartbeatIntervalMs() * 4, 2 * 60 * 1000);
}

function resolveWritableJobStoreDir(): void {
  const probeName = '.codex-mcp-write-probe';
  const canWriteRoot = (root: string): boolean => {
    try {
      mkdirSync(root, { recursive: true });
      const probePath = join(root, probeName);
      writeFileSync(probePath, 'ok', 'utf8');
      unlinkSync(probePath);
      return true;
    } catch {
      return false;
    }
  };

  if (canWriteRoot(PRIMARY_JOB_STORE_DIR)) {
    activeJobStoreDir = PRIMARY_JOB_STORE_DIR;
    JOB_STORE_FILE = join(activeJobStoreDir, 'jobs.json');
    JOB_STORE_LOCK_DIR = join(activeJobStoreDir, 'jobs.lock');
    return;
  }

  mkdirSync(FALLBACK_JOB_STORE_DIR, { recursive: true });
  activeJobStoreDir = FALLBACK_JOB_STORE_DIR;
  JOB_STORE_FILE = join(activeJobStoreDir, 'jobs.json');
  JOB_STORE_LOCK_DIR = join(activeJobStoreDir, 'jobs.lock');
}

function notify(jobId: string): void {
  const callbacks = waiters.get(jobId);
  if (!callbacks || callbacks.length === 0) return;
  waiters.delete(jobId);
  for (const cb of callbacks) cb();
}

function normalizeLoadedJob(job: AsyncJob): AsyncJob {
  return {
    ...job,
    updates: Array.isArray(job.updates) ? job.updates : [],
    metadata: job.metadata || undefined,
  };
}

function loadJobsFromDisk(): void {
  try {
    if (!existsSync(JOB_STORE_FILE)) {
      return;
    }

    const raw = readFileSync(JOB_STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PersistedJobs;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      Logger.warn(`Invalid jobs store format at ${JOB_STORE_FILE}, starting clean`);
      return;
    }

    const loaded = parsed.jobs.map(normalizeLoadedJob);
    for (const job of loaded) {
      jobs.set(job.id, job);
    }

    pruneIfNeeded();

    Logger.debug(`Loaded ${jobs.size} persisted job(s) from disk`);
  } catch (error) {
    Logger.error('Failed loading persisted jobs:', error);
  }
}

function readPersistedJobsUnsafe(): AsyncJob[] {
  if (!existsSync(JOB_STORE_FILE)) return [];
  try {
    const raw = readFileSync(JOB_STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PersistedJobs;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) return [];
    return parsed.jobs.map(normalizeLoadedJob);
  } catch {
    return [];
  }
}

function mergeJobsByRecency(target: Map<string, AsyncJob>, source: AsyncJob[]): void {
  for (const incoming of source) {
    const existing = target.get(incoming.id);
    if (!existing) {
      target.set(incoming.id, incoming);
      continue;
    }

    if (incoming.updatedAt > existing.updatedAt) {
      target.set(incoming.id, incoming);
      continue;
    }
    if (incoming.updatedAt < existing.updatedAt) {
      continue;
    }

    if ((incoming.updates?.length || 0) > (existing.updates?.length || 0)) {
      target.set(incoming.id, incoming);
      continue;
    }
    if (!!incoming.completedAt && !existing.completedAt) {
      target.set(incoming.id, incoming);
    }
  }
}

function syncJobsFromDisk(): void {
  const diskJobs = readPersistedJobsUnsafe();
  if (diskJobs.length === 0) return;
  mergeJobsByRecency(jobs, diskJobs);
  pruneIfNeeded();
}

function persistNow(): void {
  try {
    withFileLockSync(JOB_STORE_LOCK_DIR, () => {
      mkdirSync(activeJobStoreDir, { recursive: true });
      syncJobsFromDisk();
      const data: PersistedJobs = {
        version: 1,
        jobs: [...jobs.values()],
      };
      const tmpFile = `${JOB_STORE_FILE}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmpFile, JOB_STORE_FILE);
    });
  } catch (error) {
    Logger.error('Failed persisting jobs:', error);
  }
}

function schedulePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    persistNow();
  }, 75);
}

function pruneIfNeeded(): void {
  if (jobs.size <= MAX_JOBS) return;
  const oldest = [...jobs.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, jobs.size - MAX_JOBS);
  for (const job of oldest) {
    jobs.delete(job.id);
    waiters.delete(job.id);
  }
}

function appendJobUpdateInternal(job: AsyncJob, message: string): void {
  const update: JobUpdate = {
    seq: job.updates.length + 1,
    timestamp: nowIso(),
    message,
  };
  job.updates.push(update);
  if (job.updates.length > MAX_UPDATES_PER_JOB) {
    job.updates = job.updates.slice(job.updates.length - MAX_UPDATES_PER_JOB);
  }
  job.updatedAt = nowIso();
}

function reconcileStaleRunningJob(jobId: string, job: AsyncJob): boolean {
  if (job.status !== 'running') return false;
  const updatedAtMs = Date.parse(job.updatedAt || job.createdAt);
  if (!Number.isFinite(updatedAtMs)) return false;

  const staleMs = getRunningJobStaleMs();
  const ageMs = Date.now() - updatedAtMs;
  if (ageMs < staleMs) return false;

  const staleSec = Math.floor(ageMs / 1000);
  job.status = 'failed';
  job.error = `Job became orphaned while running (no updates for ${staleSec}s)`;
  job.completedAt = nowIso();
  appendJobUpdateInternal(job, `Job failed: ${job.error}`);
  notify(jobId);
  return true;
}

resolveWritableJobStoreDir();
loadJobsFromDisk();

export function createJob(metadata?: Record<string, string | number | boolean>): AsyncJob {
  const timestamp = nowIso();
  const job: AsyncJob = {
    id: randomUUID(),
    status: 'queued',
    createdAt: timestamp,
    updatedAt: timestamp,
    updates: [],
    metadata,
  };
  jobs.set(job.id, job);
  pruneIfNeeded();
  persistNow();
  schedulePersist();
  return job;
}

export function recordCompletedSessionThread(
  threadId: string,
  metadata?: Record<string, string | number | boolean>
): AsyncJob {
  const timestamp = nowIso();
  const job: AsyncJob = {
    id: randomUUID(),
    status: 'succeeded',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    updates: [
      {
        seq: 1,
        timestamp,
        message: 'Captured thread from synchronous ask-codex call',
      },
    ],
    threadId,
    metadata,
  };
  jobs.set(job.id, job);
  pruneIfNeeded();
  schedulePersist();
  return job;
}

export function setJobThreadId(jobId: string, threadId?: string): void {
  if (!threadId) return;
  const job = jobs.get(jobId);
  if (!job) return;
  job.threadId = threadId;
  job.updatedAt = nowIso();
  schedulePersist();
  notify(jobId);
}

export function mergeJobMetadata(
  jobId: string,
  metadata?: Record<string, string | number | boolean>
): void {
  if (!metadata || Object.keys(metadata).length === 0) return;
  const job = jobs.get(jobId);
  if (!job) return;
  job.metadata = {
    ...(job.metadata || {}),
    ...metadata,
  };
  job.updatedAt = nowIso();
  schedulePersist();
  notify(jobId);
}

export function getJob(jobId: string): AsyncJob | undefined {
  syncJobsFromDisk();
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (reconcileStaleRunningJob(jobId, job)) {
    schedulePersist();
  }
  return job;
}

export function getMostRecentThreadId(): string | undefined {
  syncJobsFromDisk();
  const latestWithThread = [...jobs.values()]
    .filter(job => !!job.threadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latestWithThread?.threadId;
}

export function appendJobUpdate(jobId: string, message: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  appendJobUpdateInternal(job, message);
  schedulePersist();
  notify(jobId);
}

export function getJobSnapshot(jobId: string, sinceSeq = 0): JobSnapshot | undefined {
  syncJobsFromDisk();
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (reconcileStaleRunningJob(jobId, job)) {
    schedulePersist();
  }
  const updates = job.updates.filter(u => u.seq > sinceSeq);
  const latestSeq = job.updates.length === 0 ? 0 : job.updates[job.updates.length - 1].seq;
  return { job, updates, latestSeq };
}

export async function waitForJobUpdate(
  jobId: string,
  sinceSeq: number,
  waitMs: number
): Promise<JobSnapshot | undefined> {
  const initial = getJobSnapshot(jobId, sinceSeq);
  if (!initial) return undefined;
  if (initial.updates.length > 0 || initial.job.status === 'succeeded' || initial.job.status === 'failed') {
    return initial;
  }

  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, waitMs);
    const list = waiters.get(jobId) || [];
    list.push(() => {
      clearTimeout(timeout);
      resolve();
    });
    waiters.set(jobId, list);
  });

  return getJobSnapshot(jobId, sinceSeq);
}

export function startJob(
  jobId: string,
  runner: (onUpdate: (message: string) => void) => Promise<string | JobRunResult>
): void {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'running';
  job.updatedAt = nowIso();
  appendJobUpdate(jobId, 'Job started');
  const heartbeatIntervalMs = getHeartbeatIntervalMs();
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const current = jobs.get(jobId);
    if (!current || current.status !== 'running') {
      clearInterval(heartbeat);
      return;
    }
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    appendJobUpdate(jobId, `Job still running (${elapsedSec}s elapsed)`);
  }, heartbeatIntervalMs);

  void runner(message => appendJobUpdate(jobId, message))
    .then(outcome => {
      clearInterval(heartbeat);
      const current = jobs.get(jobId);
      if (!current) return;

      const normalized: JobRunResult =
        typeof outcome === 'string' ? { result: outcome } : outcome;

      current.status = 'succeeded';
      current.result = normalized.result;
      current.threadId = normalized.threadId || current.threadId;
      if (normalized.metadata) {
        current.metadata = {
          ...(current.metadata || {}),
          ...normalized.metadata,
        };
      }
      current.updatedAt = nowIso();
      current.completedAt = nowIso();
      appendJobUpdate(jobId, 'Job completed');
      schedulePersist();
      notify(jobId);
    })
    .catch(error => {
      clearInterval(heartbeat);
      const current = jobs.get(jobId);
      if (!current) return;
      current.status = 'failed';
      current.error = error instanceof Error ? error.message : String(error);
      current.updatedAt = nowIso();
      current.completedAt = nowIso();
      appendJobUpdate(jobId, `Job failed: ${current.error}`);
      schedulePersist();
      notify(jobId);
    });
}
