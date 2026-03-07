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
} from '../utils/jobManager.js';

const askCodexArgsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("Task or question. Use @ to include files (e.g., '@largefile.ts explain')."),
  model: z
    .string()
    .optional()
    .describe(`Model: ${Object.values(MODELS).join(', ')}. Default: gpt-5.3-codex`),
  async: z
    .boolean()
    .default(true)
    .describe('Run asynchronously and return a jobId immediately (default: true)'),
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
});

export const askCodexTool: UnifiedTool = {
  name: 'ask-codex',
  description:
    'Execute Codex CLI with file analysis (@syntax), model selection, and safety controls. Supports changeMode.',
  zodSchema: askCodexArgsSchema,
  prompt: {
    description: 'Execute Codex CLI with optional changeMode',
  },
  category: 'utility',
  execute: async (args, onProgress) => {
    const {
      prompt,
      model,
      async: asyncMode,
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
    } = args;
    const effectiveModel = ((model as string | undefined) || MODELS.GPT5_CODEX) as string;
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

    if (asyncMode) {
      const job = createJob({
        tool: 'ask-codex',
        model: effectiveModel,
        ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
      });

      startJob(job.id, async onUpdate => {
        const session = await executeCodexSession(
          prompt as string,
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

      const asyncLines = [
        '✅ Async job started',
        `jobId: ${job.id}`,
        'status: queued',
      ];
      if (explicitThreadId) {
        asyncLines.push(`threadId: ${effectiveThreadId}`);
      } else if (resume === 'recent' && effectiveThreadId) {
        asyncLines.push(`threadId: ${effectiveThreadId}`);
        asyncLines.push('threadSource: most-recent-job');
      }
      asyncLines.push(
        '',
        'Use get-codex-job with:',
        `- jobId: ${job.id}`,
        '- sinceSeq: 0',
        '- waitMs: <milliseconds> (optional long-poll)'
      );
      return asyncLines.join('\n');
    }

    try {
      // Use enhanced executeCodex for better feature support
      const session = await executeCodexSession(
        prompt as string,
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
        onProgress
      );

      if (changeMode) {
        return processChangeModeOutput(session.content, {
          chunkIndex: args.chunkIndex as number | undefined,
          prompt: prompt as string,
        });
      }

      // Format response with enhanced output parsing
      const formatted = formatCodexResponseForMCP(
        session.content,
        includeThinking as boolean,
        includeMetadata as boolean
      );
      if (session.threadId) {
        recordCompletedSessionThread(session.threadId, {
          tool: 'ask-codex',
          mode: 'sync',
          model: effectiveModel,
        });
        const sourceLine =
          explicitThreadId || !effectiveThreadId || resume !== 'recent'
            ? ''
            : '\nthreadSource: most-recent-job';
        return `${formatted}\n\nthreadId: ${session.threadId}${sourceLine}`;
      }
      return formatted;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Enhanced error handling with helpful context
      if (errorMessage.includes('not found') || errorMessage.includes('command not found')) {
        return `❌ **Codex CLI Not Found**: ${ERROR_MESSAGES.CODEX_NOT_FOUND}

**Quick Fix:**
\`\`\`bash
npm install -g @openai/codex
\`\`\`

**Verification:** Run \`codex --version\` to confirm installation.`;
      }

      if (errorMessage.includes('authentication') || errorMessage.includes('unauthorized')) {
        return `❌ **Authentication Failed**: ${ERROR_MESSAGES.AUTHENTICATION_FAILED}

**Setup Options:**
1. **API Key:** \`export OPENAI_API_KEY=your-key\`
2. **Login:** \`codex login\` (requires ChatGPT subscription)

**Troubleshooting:** Verify key has Codex access in OpenAI dashboard.`;
      }

      if (errorMessage.includes('quota') || errorMessage.includes('rate limit')) {
        return `❌ **Usage Limit Reached**: ${ERROR_MESSAGES.QUOTA_EXCEEDED}

**Solutions:**
1. Wait and retry - rate limits reset periodically
2. Check quota in OpenAI dashboard`;
      }

      if (errorMessage.includes('sandbox') || errorMessage.includes('permission')) {
        // Enhanced debugging information
        const debugInfo = [
          `**Current Configuration:**`,
          `- sandboxMode: ${sandboxMode}`,
          `- approvalPolicy: ${approvalPolicy}`,
          `- search: ${search}`,
          `- oss: ${oss}`
        ].join('\n');

        return `❌ **Permission Error**: ${ERROR_MESSAGES.SANDBOX_VIOLATION}

${debugInfo}

**Root Cause:**
This error typically occurs when:
1. \`approvalPolicy\` is set without \`sandboxMode\` (now auto-fixed in v1.2+)
2. Explicit \`sandboxMode: "read-only"\` blocks file modifications
3. Codex CLI defaults to restrictive permissions

**Solutions:**

**Option A - Explicit Control (Recommended):**
\`\`\`json
{
  "approvalPolicy": "on-failure",
  "sandboxMode": "workspace-write",
  "model": "gpt-5.3-codex",
  "prompt": "your task..."
}
\`\`\`

**Sandbox Modes:**
- \`read-only\`: Analysis only, no modifications
- \`workspace-write\`: Can edit files in workspace (safe for most tasks)
- \`danger-full-access\`: Full system access (use with caution)`;
      }

      // Generic error with context
      return `❌ **Codex Execution Error**: ${errorMessage}

**Debug Steps:**
1. Verify Codex CLI: \`codex --version\`
2. Check authentication: \`codex login\`
3. Try simpler query first`;
    }
  },
};
