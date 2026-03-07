#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { Logger } from './utils/logger.js';
import { createMcpServer } from './serverFactory.js';

const SERVER_VERSION = '1.3.11';

async function main() {
  process.on('uncaughtException', err => {
    Logger.error('uncaughtException', err);
  });
  process.on('unhandledRejection', reason => {
    Logger.error('unhandledRejection', reason);
  });

  const configuredCwd = process.env.CODEX_MCP_CWD;
  if (configuredCwd && configuredCwd.trim().length > 0) {
    try {
      process.chdir(configuredCwd);
    } catch (error) {
      Logger.error(`Failed to chdir to CODEX_MCP_CWD=${configuredCwd}:`, error);
    }
  }

  Logger.warn(
    `startup version=${SERVER_VERSION} node=${process.version} cwd=${process.cwd()} tmp=${process.env.CODEX_MCP_TMP_DIR || 'default'}`
  );

  const server = createMcpServer(SERVER_VERSION);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  Logger.debug('codex-mcp-tool listening on stdio');
}

main().catch(error => {
  Logger.error('Fatal error:', error);
  process.exit(1);
});
