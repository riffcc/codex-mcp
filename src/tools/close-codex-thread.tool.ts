import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { despawnCodexThread } from '../utils/tmuxCodexExecutor.js';

const closeCodexThreadArgsSchema = z.object({
  threadId: z.string().min(1).describe('Codex threadId to close and despawn its tmux pane'),
});

export const closeCodexThreadTool: UnifiedTool = {
  name: 'close-codex-thread',
  description: 'Despawn the tmux pane bound to a Codex threadId',
  zodSchema: closeCodexThreadArgsSchema,
  category: 'utility',
  execute: async args => {
    const { threadId } = args as any;
    const closed = await despawnCodexThread(threadId as string);
    return closed
      ? `Closed Codex thread pane for threadId: ${threadId}`
      : `No active pane found for threadId: ${threadId}`;
  },
};
