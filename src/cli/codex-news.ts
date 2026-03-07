#!/usr/bin/env node

import { askCodexTool } from '../tools/ask-codex.tool.js';
import { waitForJobUpdate } from '../utils/jobManager.js';

type JsonObject = Record<string, unknown>;

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function printUsage(): void {
  const lines = [
    'codex-news - submit MCP-style params and block until there is job news',
    '',
    'Usage:',
    "  codex-news --params '<json>' [--since-seq <n>]",
    "  cat params.json | codex-news --params - [--since-seq <n>]",
    '',
    'Examples:',
    '  codex-news --params \'{"prompt":"Fix @src/app.ts","model":"o3"}\'',
    '  codex-news --params \'{"jobId":"<existing-job-id>"}\' --since-seq 12',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseParams(raw: string | undefined): Promise<JsonObject> {
  if (!raw) {
    throw new Error('Missing --params');
  }
  const payload = raw === '-' ? (await readStdin()).trim() : raw.trim();
  if (!payload) {
    throw new Error('Empty params payload');
  }
  const parsed = JSON.parse(payload);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Params must be a JSON object');
  }
  return parsed as JsonObject;
}

function extractJobId(text: string): string | undefined {
  const match = text.match(/jobId:\s*([a-f0-9-]+)/i);
  return match?.[1];
}

async function startAsyncJobFromParams(params: JsonObject): Promise<string> {
  const response = await askCodexTool.execute({ ...params, async: true });
  const jobId = extractJobId(response);
  if (!jobId) {
    throw new Error(`Failed to parse jobId from ask-codex response:\n${response}`);
  }
  return jobId;
}

async function waitUntilNews(jobId: string, initialSinceSeq: number): Promise<void> {
  let sinceSeq = initialSinceSeq;

  while (true) {
    // Intentionally loops forever without command-level timeout.
    const snapshot = await waitForJobUpdate(jobId, sinceSeq, 600000);
    if (!snapshot) {
      throw new Error(`Unknown jobId: ${jobId}`);
    }

    const hasNews = snapshot.updates.length > 0;
    const terminal = snapshot.job.status === 'succeeded' || snapshot.job.status === 'failed';

    if (hasNews || terminal) {
      const payload = {
        jobId: snapshot.job.id,
        status: snapshot.job.status,
        threadId: snapshot.job.threadId,
        latestSeq: snapshot.latestSeq,
        nextSinceSeq: snapshot.latestSeq,
        updates: snapshot.updates,
        result: terminal ? snapshot.job.result : undefined,
        error: snapshot.job.status === 'failed' ? snapshot.job.error : undefined,
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    sinceSeq = snapshot.latestSeq;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const paramsRaw = readFlag(args, '--params');
  const sinceSeqRaw = readFlag(args, '--since-seq');
  const sinceSeq = sinceSeqRaw ? Number(sinceSeqRaw) : 0;
  if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
    throw new Error('--since-seq must be a non-negative number');
  }

  const params = await parseParams(paramsRaw);

  const existingJobId =
    typeof params.jobId === 'string' && params.jobId.trim().length > 0 ? params.jobId.trim() : undefined;

  const jobId = existingJobId || (await startAsyncJobFromParams(params));
  await waitUntilNews(jobId, sinceSeq);
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

