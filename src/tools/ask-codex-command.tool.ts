import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeCodexSession } from '../utils/codexExecutor.js';
import { processChangeModeOutput } from '../utils/changeModeRunner.js';
import { formatCodexResponseForMCP } from '../utils/outputParser.js';
import { MODELS, APPROVAL_POLICIES, ERROR_MESSAGES } from '../constants.js';
import {
  createJob,
  getMostRecentThreadId,
  recordCompletedSessionThread,
  setJobThreadId,
  startJob,
  waitForJobUpdate,
} from '../utils/jobManager.js';

const SMART_READ_LAYERS = [
  'raw',
  'ast',
  'call_graph',
  'cfg',
  'dfg',
  'pdg',
  'theory_graph',
] as const;

function buildSmartReadEditFeedbackPrompt(
  prompt: string,
  options: {
    smartReadLayers?: readonly string[];
    smartReadMaxFiles?: number;
    smartReadFocus?: string;
  }
): string {
  const layers = (options.smartReadLayers && options.smartReadLayers.length > 0
    ? options.smartReadLayers
    : ['ast', 'call_graph']) as readonly string[];
  const maxFiles = options.smartReadMaxFiles && options.smartReadMaxFiles > 0
    ? options.smartReadMaxFiles
    : 4;
  const focus = options.smartReadFocus?.trim();

  const instruction = [
    'When you make edits, immediately inspect the affected code with llm_code_sdk smart_read before finalizing.',
    'Use smart_read in batch mode against the files you actually changed.',
    `Use these SmartRead layers: ${layers.join(', ')}.`,
    `Keep the SmartRead pass focused to the most important ${maxFiles} changed file${maxFiles === 1 ? '' : 's'}.`,
    focus ? `Bias the SmartRead analysis toward: ${focus}.` : '',
    'Use the SmartRead results to understand knock-on effects, call relationships, control/data dependencies, and structural impact.',
    'Return a compact "SmartRead Impact" section in the final answer.',
    'Do not include raw diffs or patch bodies in that section.',
  ]
    .filter(Boolean)
    .join('\n');

  return `${prompt}\n\n[Built-in SmartRead edit feedback]\n${instruction}`;
}

const askCodexCommandArgsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("Task or question. Use @ to include files (e.g., '@largefile.ts explain')."),
  model: z
    .string()
    .optional()
    .describe(`Model: ${Object.values(MODELS).join(', ')}. Default: ${MODELS.GPT5_4}`),
  approvalPolicy: z
    .enum(['never', 'on-request', 'on-failure', 'untrusted'])
    .optional()
    .describe('Approval: never, on-request, on-failure, untrusted'),
  approval: z
    .string()
    .optional()
    .describe(`Approval policy: ${Object.values(APPROVAL_POLICIES).join(', ')}`),
  sandboxMode: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .describe('Access: read-only, workspace-write, danger-full-access'),
  cd: z.string().optional().describe('Working directory'),
  workingDir: z.string().optional().describe('Working directory for execution'),
  threadId: z.string().optional().describe('Continue an existing Codex thread (uses codex-reply)'),
  resume: z
    .enum(['none', 'recent'])
    .default('none')
    .describe('Resume behavior when threadId is omitted: "none" (default) or "recent"'),
  changeMode: z
    .boolean()
    .default(false)
    .describe('Return structured OLD/NEW edits for refactoring'),
  chunkIndex: z
    .preprocess(val => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? undefined : parsed;
      }
      return undefined;
    }, z.number().min(1).optional())
    .describe('Chunk index (1-based)'),
  chunkCacheKey: z.string().optional().describe('Cache key for continuation'),
  image: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Optional image file path(s) to include with the prompt'),
  config: z
    .union([z.string(), z.record(z.any())])
    .optional()
    .describe("Configuration overrides as 'key=value' string or object"),
  profile: z.string().optional().describe('Configuration profile to use from ~/.codex/config.toml'),
  includeThinking: z
    .boolean()
    .default(true)
    .describe('Include reasoning/thinking section in response'),
  includeMetadata: z.boolean().default(true).describe('Include configuration metadata in response'),
  search: z
    .boolean()
    .optional()
    .describe(
      'Enable web search by activating web_search_request feature flag. Requires network access - automatically sets sandbox to workspace-write if not specified.'
    ),
  oss: z
    .boolean()
    .optional()
    .describe(
      'Use local Ollama server (convenience for -c model_provider=oss). Requires Ollama running locally. Automatically sets sandbox to workspace-write if not specified.'
    ),
  enableFeatures: z
    .array(z.string())
    .optional()
    .describe('Enable feature flags (repeatable). Equivalent to -c features.<name>=true'),
  disableFeatures: z
    .array(z.string())
    .optional()
    .describe('Disable feature flags (repeatable). Equivalent to -c features.<name>=false'),
  mcpServers: z
    .record(z.any())
    .optional()
    .describe('Additional MCP servers to inject into Codex config as mcp_servers'),
  smartReadLayers: z
    .array(z.enum(SMART_READ_LAYERS))
    .optional()
    .describe(
      'If set, ask Codex to run llm_code_sdk smart_read on files it changed and include a compact impact summary.'
    ),
  smartReadMaxFiles: z
    .number()
    .int()
    .min(1)
    .max(12)
    .default(4)
    .describe('Maximum changed files to inspect with SmartRead when smartReadLayers is enabled'),
  smartReadFocus: z
    .string()
    .optional()
    .describe('Optional focus for SmartRead impact analysis, e.g. call chain, data flow, or side effects'),
});

export const askCodexCommandTool: UnifiedTool = {
  name: 'ask-codex-command',
  description:
    'Single-call blocking Codex execution. Starts an internal job and waits for final reply in one tool call.',
  zodSchema: askCodexCommandArgsSchema,
  prompt: {
    description: 'Execute Codex and wait for completion in this single call',
  },
  category: 'utility',
  execute: async (args, onProgress) => {
    const {
      prompt,
      model,
      approvalPolicy,
      approval,
      sandboxMode,
      cd,
      workingDir,
      threadId,
      resume,
      changeMode,
      chunkIndex,
      chunkCacheKey,
      image,
      config,
      profile,
      includeThinking,
      includeMetadata,
      search,
      oss,
      enableFeatures,
      disableFeatures,
      mcpServers,
      smartReadLayers,
      smartReadMaxFiles,
      smartReadFocus,
    } = args;

    const effectiveModel = ((model as string | undefined) || MODELS.GPT5_4) as string;
    const effectivePrompt =
      smartReadLayers && (smartReadLayers as string[]).length > 0
        ? buildSmartReadEditFeedbackPrompt(prompt as string, {
            smartReadLayers: smartReadLayers as string[],
            smartReadMaxFiles: smartReadMaxFiles as number,
            smartReadFocus: smartReadFocus as string | undefined,
          })
        : (prompt as string);
    const explicitThreadId =
      typeof threadId === 'string' && threadId.trim().length > 0 ? threadId.trim() : undefined;
    const effectiveThreadId =
      explicitThreadId || (resume === 'recent' ? getMostRecentThreadId() : undefined);

    if (!prompt?.trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    if (changeMode && chunkIndex && chunkCacheKey) {
      return processChangeModeOutput('', {
        chunkIndex: chunkIndex as number,
        cacheKey: chunkCacheKey as string,
        prompt: prompt as string,
      });
    }

    const job = createJob({
      tool: 'ask-codex-command',
      mode: 'blocking',
      model: effectiveModel,
      ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
    });

    startJob(job.id, async onUpdate => {
      const session = await executeCodexSession(
        effectivePrompt,
        {
          threadId: effectiveThreadId,
          model: effectiveModel,
          approvalPolicy: approvalPolicy as any,
          approval: approval as string,
          sandboxMode: sandboxMode as any,
          cd: cd as string,
          workingDir: workingDir as string,
          image,
          config,
          profile: profile as string,
          search: search as boolean,
          oss: oss as boolean,
          enableFeatures: enableFeatures as string[],
          disableFeatures: disableFeatures as string[],
          mcpServers: mcpServers as Record<string, unknown>,
        },
        onUpdate
      );
      setJobThreadId(job.id, session.threadId);

      if (changeMode) {
        return {
          result: await processChangeModeOutput(session.content, {
            chunkIndex: args.chunkIndex as number | undefined,
            prompt: prompt as string,
          }),
          threadId: session.threadId,
        };
      }

      return {
        result: formatCodexResponseForMCP(
          session.content,
          includeThinking as boolean,
          includeMetadata as boolean
        ),
        threadId: session.threadId,
      };
    });

    const buildAsyncFallbackResponse = (seq: number) =>
      [
        'Codex job is running asynchronously.',
        `jobId: ${job.id}`,
        `sinceSeq: ${seq}`,
        'Use get-codex-job to poll for completion.',
      ].join('\n');

    const maxBlockingMsRaw = Number(process.env.CODEX_MCP_BLOCKING_MAX_MS || 50000);
    const immediateAsyncMode = Number.isFinite(maxBlockingMsRaw) && maxBlockingMsRaw <= 0;
    const maxBlockingMs =
      Number.isFinite(maxBlockingMsRaw) && maxBlockingMsRaw > 0 ? maxBlockingMsRaw : 50000;

    if (immediateAsyncMode) {
      return buildAsyncFallbackResponse(0);
    }
    const startedAt = Date.now();

    let sinceSeq = 0;
    let progressTicks = 0;
    while (true) {
      const snapshot = await waitForJobUpdate(job.id, sinceSeq, 1500);
      if (!snapshot) {
        throw new Error(`Failed to read job state for jobId=${job.id}`);
      }
      sinceSeq = snapshot.latestSeq;

      if (onProgress && snapshot.updates.length > 0) {
        const latest = snapshot.updates[snapshot.updates.length - 1];
        onProgress(`[job ${job.id}][${latest.seq}] ${latest.message}`);
      } else if (onProgress) {
        progressTicks += 1;
        onProgress(`Waiting for Codex reply... (${progressTicks})`);
      }

      if (snapshot.job.status === 'succeeded') {
        if (snapshot.job.threadId) {
          recordCompletedSessionThread(snapshot.job.threadId, {
            tool: 'ask-codex-command',
            mode: 'blocking',
            model: effectiveModel,
          });
        }
        return snapshot.job.result || '';
      }

      if (snapshot.job.status === 'failed') {
        throw new Error(snapshot.job.error || 'Codex command job failed');
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxBlockingMs) {
        return buildAsyncFallbackResponse(sinceSeq);
      }
    }
  },
};
