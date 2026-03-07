import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeCodex } from '../utils/codexExecutor.js';
import { ERROR_MESSAGES, STATUS_MESSAGES, MODELS, SANDBOX_MODES } from '../constants.js';

// Define task type for batch operations
const batchTaskSchema = z.object({
  task: z.string().describe('Atomic task description'),
  target: z.string().optional().describe('Target files/directories (use @ syntax)'),
  priority: z.enum(['high', 'normal', 'low']).default('normal').describe('Task priority'),
});

const batchCodexArgsSchema = z.object({
  tasks: z.array(batchTaskSchema).min(1).describe('Array of atomic tasks to delegate to Codex'),
  model: z
    .string()
    .optional()
    .describe(`Model to use: ${Object.values(MODELS).join(', ')}`),
  sandbox: z
    .string()
    .default(SANDBOX_MODES.WORKSPACE_WRITE)
    .describe(`Sandbox mode: ${Object.values(SANDBOX_MODES).join(', ')}`),
  parallel: z.boolean().default(false).describe('Execute tasks in parallel (experimental)'),
  stopOnError: z.boolean().default(true).describe('Stop execution if any task fails'),
  workingDir: z.string().optional().describe('Working directory for execution'),
  search: z
    .boolean()
    .optional()
    .describe('Enable web search for all tasks (activates web_search_request feature)'),
  oss: z.boolean().optional().describe('Use local Ollama server'),
  enableFeatures: z.array(z.string()).optional().describe('Enable feature flags'),
  disableFeatures: z.array(z.string()).optional().describe('Disable feature flags'),
});

export const batchCodexTool: UnifiedTool = {
  name: 'batch-codex',
  description:
    'Delegate multiple atomic tasks to Codex for batch processing. Ideal for repetitive operations, mass refactoring, and automated code transformations',
  zodSchema: batchCodexArgsSchema,
  prompt: {
    description: 'Execute multiple atomic Codex tasks in batch mode for efficient automation',
  },
  category: 'codex',
  execute: async (args, onProgress) => {
    const {
      tasks,
      model,
      sandbox,
      parallel,
      stopOnError,
      workingDir,
      search,
      oss,
      enableFeatures,
      disableFeatures,
    } = args;
    const taskList = tasks as Array<{
      task: string;
      target?: string;
      priority: string;
    }>;

    if (!taskList || taskList.length === 0) {
      throw new Error('No tasks provided for batch execution');
    }

    const results: Array<{
      task: string;
      status: 'success' | 'failed' | 'skipped';
      output?: string;
      error?: string;
    }> = [];
    let failedCount = 0;
    let successCount = 0;

    // Sort tasks by priority
    const sortedTasks = [...taskList].sort((a, b) => {
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      return (
        priorityOrder[a.priority as keyof typeof priorityOrder] -
        priorityOrder[b.priority as keyof typeof priorityOrder]
      );
    });

    if (onProgress) {
      onProgress(`🚀 Starting batch execution of ${sortedTasks.length} tasks...`);
    }

    const executeSingleTask = async (
      task: { task: string; target?: string; priority: string },
      taskIndex: number
    ) => {
      const taskPrompt = task.target ? `${task.task} in ${task.target}` : task.task;

      if (onProgress) {
        onProgress(`\n[${taskIndex + 1}/${sortedTasks.length}] Executing: ${taskPrompt}`);
      }

      try {
        const result = await executeCodex(
          taskPrompt,
          {
            model: model as string,
            sandboxMode: sandbox as any,
            workingDir: workingDir as string,
            search: search as boolean,
            oss: oss as boolean,
            enableFeatures: enableFeatures as string[],
            disableFeatures: disableFeatures as string[],
          },
          undefined
        );

        successCount++;
        if (onProgress) {
          onProgress(`✅ Completed: ${task.task}`);
        }
        return {
          task: taskPrompt,
          status: 'success' as const,
          output: result.substring(0, 500),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedCount++;
        if (onProgress) {
          onProgress(`❌ Failed: ${task.task} - ${errorMessage}`);
        }
        return {
          task: taskPrompt,
          status: 'failed' as const,
          error: errorMessage,
        };
      }
    };

    if (!parallel) {
      for (let i = 0; i < sortedTasks.length; i++) {
        const task = sortedTasks[i];
        const taskPrompt = task.target ? `${task.task} in ${task.target}` : task.task;

        if (stopOnError && failedCount > 0) {
          results.push({
            task: taskPrompt,
            status: 'skipped',
            error: 'Skipped due to previous failure',
          });
          continue;
        }

        results.push(await executeSingleTask(task, i));
      }
    } else {
      if (onProgress) {
        onProgress('⚡ Parallel mode enabled: executing tasks by priority group.');
      }

      const grouped = {
        high: [] as Array<{ task: string; target?: string; priority: string; index: number }>,
        normal: [] as Array<{ task: string; target?: string; priority: string; index: number }>,
        low: [] as Array<{ task: string; target?: string; priority: string; index: number }>,
      };

      for (let i = 0; i < sortedTasks.length; i++) {
        const task = sortedTasks[i];
        const bucket = task.priority as keyof typeof grouped;
        grouped[bucket].push({ ...task, index: i });
      }

      const order: Array<keyof typeof grouped> = ['high', 'normal', 'low'];
      for (const priority of order) {
        const tasksInPriority = grouped[priority];
        if (tasksInPriority.length === 0) continue;

        if (stopOnError && failedCount > 0) {
          for (const task of tasksInPriority) {
            const taskPrompt = task.target ? `${task.task} in ${task.target}` : task.task;
            results.push({
              task: taskPrompt,
              status: 'skipped',
              error: 'Skipped due to previous failure',
            });
          }
          continue;
        }

        if (onProgress) {
          onProgress(
            `\n⚙️ Running ${tasksInPriority.length} ${priority}-priority task(s) in parallel...`
          );
        }

        const parallelResults = await Promise.all(
          tasksInPriority.map(task => executeSingleTask(task, task.index))
        );
        results.push(...parallelResults);
      }
    }

    // Generate summary report
    let report = `\n📊 **Batch Execution Summary**\n`;
    report += `\n- Total tasks: ${sortedTasks.length}`;
    report += `\n- Successful: ${successCount} ✅`;
    report += `\n- Failed: ${failedCount} ❌`;
    report += `\n- Skipped: ${sortedTasks.length - successCount - failedCount} ⏭️`;

    report += `\n\n**Task Results:**\n`;
    for (const result of results) {
      const icon = result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : '⏭️';
      report += `\n${icon} **${result.task}**`;
      if (result.status === 'success' && result.output) {
        report += `\n   Output: ${result.output.substring(0, 100)}...`;
      } else if (result.error) {
        report += `\n   Error: ${result.error}`;
      }
    }

    // If all tasks failed, throw an error
    if (failedCount === sortedTasks.length) {
      throw new Error(`All ${failedCount} tasks failed. See report above for details.`);
    }

    return report;
  },
};
