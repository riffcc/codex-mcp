import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { LOG_PREFIX } from '../constants.js';

const LEVEL_ORDER: Record<LoggingLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export class Logger {
  private static currentLevel: LoggingLevel =
    (process.env.CODEX_MCP_LOG_LEVEL as LoggingLevel) || 'emergency';

  static setLevel(level: LoggingLevel): void {
    this.currentLevel = level;
  }

  static getLevel(): LoggingLevel {
    return this.currentLevel;
  }

  private static shouldLog(level: LoggingLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.currentLevel];
  }

  private static formatMessage(level: LoggingLevel, message: string): string {
    return `${LOG_PREFIX} [${level.toUpperCase()}] ${message}`;
  }

  private static emit(level: LoggingLevel, message: string, ...args: any[]): void {
    if (!this.shouldLog(level)) return;
    const suffix =
      args.length > 0
        ? ' ' +
          args
            .map(arg => (arg instanceof Error ? arg.stack || arg.message : String(arg)))
            .join(' ')
        : '';
    // MCP protocol uses stdout for JSON-RPC frames; logs must go to stderr only.
    process.stderr.write(`${this.formatMessage(level, message)}${suffix}\n`);
  }

  static log(message: string, ...args: any[]): void {
    this.emit('info', message, ...args);
  }

  static warn(message: string, ...args: any[]): void {
    this.emit('warning', message, ...args);
  }

  static error(message: string, ...args: any[]): void {
    this.emit('error', message, ...args);
  }

  static debug(message: string, ...args: any[]): void {
    this.emit('debug', message, ...args);
  }

  static toolInvocation(toolName: string, args: any): void {
    this.debug(`Raw args for tool '${toolName}':`, JSON.stringify(args, null, 2));
  }

  static toolParsedArgs(
    prompt: string,
    model?: string,
    sandbox?: boolean,
    changeMode?: boolean
  ): void {
    this.debug(`Parsed prompt: "${prompt}"\nchangeMode: ${changeMode || false}`);
  }

  static commandExecution(command: string, args: string[], startTime: number): void {
    this.warn(`[${startTime}] Starting: ${command} ${args.map(arg => `"${arg}"`).join(' ')}`);

    // Store command execution start for timing analysis
    this._commandStartTimes.set(startTime, { command, args, startTime });
  }

  // Track command start times for duration calculation
  private static _commandStartTimes = new Map<
    number,
    { command: string; args: string[]; startTime: number }
  >();

  static commandComplete(startTime: number, exitCode: number | null, outputLength?: number): void {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.warn(`[${elapsed}s] Process finished with exit code: ${exitCode}`);
    if (outputLength !== undefined) {
      this.warn(`Response: ${outputLength} chars`);
    }

    // Clean up command tracking
    this._commandStartTimes.delete(startTime);
  }

  static codexResponse(response: string, tokensUsed?: number): void {
    this.debug(`Codex response: ${response.substring(0, 200)}...`);
    if (tokensUsed) {
      this.debug(`Tokens used: ${tokensUsed}`);
    }
  }
}
