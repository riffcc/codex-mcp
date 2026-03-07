// Tool Registry Index - Registers all tools
import { toolRegistry } from './registry.js';
import { askCodexTool } from './ask-codex.tool.js';
import { askCodexCommandTool } from './ask-codex-command.tool.js';
import { batchCodexTool } from './batch-codex.tool.js';
// import { reviewCodexTool } from './review-codex.tool.js';
import { pingTool, helpTool, versionTool } from './simple-tools.js';
import { brainstormTool } from './brainstorm.tool.js';
import { fetchChunkTool } from './fetch-chunk.tool.js';
import { getCodexJobTool } from './get-codex-job.tool.js';
import { listCodexThreadsTool } from './list-codex-threads.tool.js';
import { closeCodexThreadTool } from './close-codex-thread.tool.js';
import { timeoutTestTool } from './timeout-test.tool.js';

toolRegistry.push(
  askCodexTool,
  askCodexCommandTool,
  batchCodexTool,
  // reviewCodexTool,
  pingTool,
  helpTool,
  versionTool,
  brainstormTool,
  fetchChunkTool,
  getCodexJobTool,
  listCodexThreadsTool,
  closeCodexThreadTool,
  timeoutTestTool
);

export * from './registry.js';
