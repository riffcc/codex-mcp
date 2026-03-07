import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { getJobSnapshot, waitForJobUpdate } from '../utils/jobManager.js';

const getCodexJobArgsSchema = z.object({
  jobId: z.string().min(1).describe('Async job ID returned by ask-codex with async=true'),
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
});

export const getCodexJobTool: UnifiedTool = {
  name: 'get-codex-job',
  description:
    'Retrieve status and incremental output for async ask-codex jobs. Supports long-polling and sequence-based updates.',
  zodSchema: getCodexJobArgsSchema,
  category: 'utility',
  execute: async args => {
    const { jobId, sinceSeq = 0, waitMs = 0, includeResult = true } = args as any;

    const snapshot =
      waitMs > 0
        ? await waitForJobUpdate(jobId as string, sinceSeq as number, waitMs as number)
        : getJobSnapshot(jobId as string, sinceSeq as number);

    if (!snapshot) {
      return `❌ Unknown jobId: ${jobId}`;
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

    if (job.threadId) {
      lines.push('', `resumeHint: call ask-codex with { "threadId": "${job.threadId}", "prompt": "<next prompt>" }`);
    }

    return lines.join('\n');
  },
};
