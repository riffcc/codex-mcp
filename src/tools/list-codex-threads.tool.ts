import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { listThreadBindings } from '../utils/tmuxCodexExecutor.js';

const listCodexThreadsArgsSchema = z.object({
  includeCountOnly: z.boolean().default(false).describe('Return only the number of active thread panes'),
});

export const listCodexThreadsTool: UnifiedTool = {
  name: 'list-codex-threads',
  description: 'List active Codex thread-to-tmux-pane bindings managed by the tmux backend',
  zodSchema: listCodexThreadsArgsSchema,
  category: 'utility',
  execute: async args => {
    const { includeCountOnly = false } = args as any;
    const bindings = await listThreadBindings();

    if (includeCountOnly) {
      return `activeThreads: ${bindings.length}`;
    }

    if (bindings.length === 0) {
      return 'No active Codex thread panes';
    }

    const lines = [`activeThreads: ${bindings.length}`, 'threads:'];
    for (const binding of bindings) {
      lines.push(`- threadId: ${binding.threadId}`);
      lines.push(`  paneId: ${binding.paneId}`);
    }
    return lines.join('\n');
  },
};
