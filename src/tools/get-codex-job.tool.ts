import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { getJobSnapshot, getJobSnapshotForThread, waitForJobUpdate } from '../utils/jobManager.js';

const getCodexJobArgsSchema = z
  .object({
    jobId: z.string().min(1).optional().describe('Async job ID to inspect'),
    threadId: z.string().min(1).optional().describe('Codex thread ID to inspect via its latest known job'),
    sinceSeq: z.number().int().min(0).default(0).describe('Return updates with seq > sinceSeq'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Long-poll duration in milliseconds'),
    includeResult: z
      .boolean()
      .default(true)
      .describe('Include final result payload when job is completed'),
  })
  .refine(args => !!args.jobId || !!args.threadId, {
    message: 'Provide either jobId or threadId',
  });

export const getCodexJobTool: UnifiedTool = {
  name: 'get-codex-job',
  description:
    'Retrieve status and incremental output for Codex work by jobId or threadId. Supports long-polling and sequence-based updates.',
  zodSchema: getCodexJobArgsSchema,
  category: 'utility',
  execute: async args => {
    const { jobId, threadId, sinceSeq = 0, waitMs = 0, includeResult = true } = args as any;
    const lookupByThread = typeof threadId === 'string' && threadId.trim().length > 0;
    const lookupKey = lookupByThread ? (threadId as string) : (jobId as string);

    const snapshot =
      waitMs > 0 && !lookupByThread
        ? await waitForJobUpdate(jobId as string, sinceSeq as number, waitMs as number)
        : lookupByThread
          ? getJobSnapshotForThread(threadId as string, sinceSeq as number)
          : getJobSnapshot(jobId as string, sinceSeq as number);

    if (!snapshot) {
      return lookupByThread
        ? `❌ Unknown threadId: ${lookupKey}`
        : `❌ Unknown jobId: ${lookupKey}`;
    }

    const { job, updates, latestSeq } = snapshot;
    const lines: string[] = [
      `jobId: ${job.id}`,
      `status: ${job.status}`,
      `createdAt: ${job.createdAt}`,
      `updatedAt: ${job.updatedAt}`,
      `latestSeq: ${latestSeq}`,
      `nextSinceSeq: ${latestSeq}`,
    ];

    if (job.completedAt) {
      lines.push(`completedAt: ${job.completedAt}`);
    }
    if (job.threadId) {
      lines.push(`threadId: ${job.threadId}`);
    }
    if (lookupByThread) {
      lines.push('resolvedVia: threadId');
    }
    if (job.metadata && Object.keys(job.metadata).length > 0) {
      lines.push(`metadata: ${JSON.stringify(job.metadata)}`);
    }

    if (updates.length > 0) {
      lines.push('', 'updates:');
      for (const update of updates) {
        lines.push(`- [${update.seq}] ${update.timestamp} ${update.message}`);
      }
    }

    if (job.status === 'failed' && job.error) {
      lines.push('', `error: ${job.error}`);
    }

    if (includeResult && job.status === 'succeeded') {
      lines.push('', 'result:', job.result || '');
    }

    return lines.join('\n');
  },
};
