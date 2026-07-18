/**
 * Runner doctor utilities
 * 
 * Process discovery and cleanup functions for the runner
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import psList from 'ps-list';
import path from 'node:path';
import { createRunnerLaunchAgentLabel } from './supportedTopology';

const DEFAULT_PROCESS_COMMAND_MAX_LENGTH = 240;
const SENSITIVE_VALUE_FLAGS = new Set(['--payload', '--initial-message', '--message', '--prompt']);
const SAFE_VALUE_FLAGS = new Set([
  '--cwd',
  '--directory',
  '--effort',
  '--hapi-agent',
  '--hapi-starting-mode',
  '--model',
  '--model-reasoning-effort',
  '--permission-mode',
  '--resume',
  '--service-tier',
  '--session',
  '--worktree-name'
]);
const SAFE_POSITIONAL_TOKENS = new Set([
  'auth',
  'claude',
  'codex',
  'cursor',
  'doctor',
  'agy',
  'grok',
  'hapi',
  'happy',
  'node',
  'opencode',
  'runner',
  'src/index.ts',
  'start',
  'start-sync',
  'status',
  'stop'
]);

export type ProcessCommandSanitizeOptions = {
  maxLength?: number;
};

export type FindHappyProcessesOptions = {
  fullArgs?: boolean;
};

export type RunnerLaunchAgentSpec = {
  label: string;
  programArguments: [string, string, 'runner', 'start-sync'];
  environmentVariables: { HAPI_HOME: string; HAPI_RUNNER_SUPERVISED: 'launchd' };
  workingDirectory: string;
  runAtLoad: true;
  keepAlive: { successfulExit: false };
  throttleInterval: 10;
  processType: 'Background';
  exitTimeOut: 20;
  standardOutPath: string;
  standardErrorPath: string;
};

export function createRunnerLaunchAgentSpec(options: {
  hapiHome: string;
  bunPath: string;
  cliEntrypoint: string;
  logPath: string;
}): RunnerLaunchAgentSpec {
  const hapiHome = path.resolve(options.hapiHome);
  return {
    label: createRunnerLaunchAgentLabel(hapiHome),
    programArguments: [path.resolve(options.bunPath), path.resolve(options.cliEntrypoint), 'runner', 'start-sync'],
    environmentVariables: { HAPI_HOME: hapiHome, HAPI_RUNNER_SUPERVISED: 'launchd' },
    workingDirectory: path.dirname(path.dirname(path.resolve(options.cliEntrypoint))),
    runAtLoad: true,
    keepAlive: { successfulExit: false },
    throttleInterval: 10,
    processType: 'Background',
    exitTimeOut: 20,
    standardOutPath: path.resolve(options.logPath),
    standardErrorPath: path.resolve(options.logPath)
  };
}

export type UnsupportedRunnerTopology = 'supervisor-script' | 'terminal-fallback' | 'monitor-loop';

const HAPI_RUNNER_SUPERVISOR_SCRIPT = /(?:^|\s)\S*(?:run[-_]hapi[-_]runner|hapi[-_]runner[-_]supervisor)\.sh(?:\s|$)/i;
const HAPI_RUNNER_MONITOR_SCRIPT = /(?:^|\s)\S*hapi[-_]runner[-_]monitor\.sh(?:\s|$)/i;
const HAPI_RUNNER_CLI_COMMAND = /\bhapi(?:-[\w.-]+)?(?:\.cjs)?\s+runner\s+(?:start(?:-sync)?|status)\b/i;

export function detectUnsupportedRunnerTopology(commands: string[]): UnsupportedRunnerTopology[] {
  const found = new Set<UnsupportedRunnerTopology>();
  for (const command of commands) {
    if (HAPI_RUNNER_SUPERVISOR_SCRIPT.test(command)) found.add('supervisor-script');
    if (HAPI_RUNNER_CLI_COMMAND.test(command)
      && /osascript\b.*(?:Terminal|do script)|open\s+-a\s+Terminal/i.test(command)) {
      found.add('terminal-fallback');
    }
    if (HAPI_RUNNER_MONITOR_SCRIPT.test(command)
      || (HAPI_RUNNER_CLI_COMMAND.test(command) && /\bwhile\s+(?:true|:)\b/i.test(command))) {
      found.add('monitor-loop');
    }
  }
  const order: UnsupportedRunnerTopology[] = ['supervisor-script', 'terminal-fallback', 'monitor-loop'];
  return order.filter((kind) => found.has(kind));
}

export async function inventoryUnsupportedRunnerTopologies(): Promise<UnsupportedRunnerTopology[]> {
  try {
    const processes = await psList();
    return detectUnsupportedRunnerTopology(processes.map((process) => process.cmd || process.name || ''));
  } catch {
    return [];
  }
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function commandTokenLooksSafe(token: string, index: number): boolean {
  const bare = stripQuotes(token);
  if (index === 0) {
    return true;
  }
  if (SAFE_POSITIONAL_TOKENS.has(bare)) {
    return true;
  }
  return bare.endsWith('/hapi') || bare.endsWith('/hapi.exe') || bare.endsWith('/bun') || bare.endsWith('/node');
}

function splitFlag(token: string): { flag: string; inlineValue: string | null } {
  const equalsIndex = token.indexOf('=');
  if (equalsIndex < 0) {
    return { flag: token, inlineValue: null };
  }
  return {
    flag: token.slice(0, equalsIndex),
    inlineValue: token.slice(equalsIndex + 1)
  };
}

function pushRedactedPositional(output: string[]): void {
  if (output[output.length - 1] !== '<arg>') {
    output.push('<arg>');
  }
}

export function sanitizeProcessCommand(command: string, options: ProcessCommandSanitizeOptions = {}): string {
  const maxLength = Math.max(40, options.maxLength ?? DEFAULT_PROCESS_COMMAND_MAX_LENGTH);
  const tokens = tokenizeCommand(command.replace(/\s+/g, ' ').trim());
  if (tokens.length === 0) {
    return '';
  }

  const output: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = stripQuotes(tokens[i] ?? '');
    if (!token) continue;

    if (token.startsWith('--')) {
      const { flag, inlineValue } = splitFlag(token);

      if (flag === '--started-by') {
        if (inlineValue === 'runner') {
          output.push('--started-by=runner', '<redacted>');
        } else if (tokens[i + 1] && stripQuotes(tokens[i + 1]) === 'runner') {
          output.push('--started-by', 'runner', '<redacted>');
          i += 1;
        } else {
          output.push('--started-by', '<redacted>');
        }
        break;
      }

      if (SENSITIVE_VALUE_FLAGS.has(flag)) {
        output.push(inlineValue === null ? `${flag} <redacted>` : `${flag}=<redacted>`);
        while (tokens[i + 1] && !stripQuotes(tokens[i + 1]).startsWith('--')) {
          i += 1;
        }
        continue;
      }

      if (SAFE_VALUE_FLAGS.has(flag)) {
        if (inlineValue !== null) {
          output.push(`${flag}=${stripQuotes(inlineValue)}`);
        } else {
          output.push(flag);
          if (tokens[i + 1] && !stripQuotes(tokens[i + 1]).startsWith('--')) {
            output.push(stripQuotes(tokens[i + 1]));
            i += 1;
          }
        }
        continue;
      }

      output.push(inlineValue === null ? flag : `${flag}=<redacted>`);
      while (tokens[i + 1] && !stripQuotes(tokens[i + 1]).startsWith('--')) {
        i += 1;
      }
      continue;
    }

    if (commandTokenLooksSafe(token, i)) {
      output.push(token);
    } else {
      pushRedactedPositional(output);
    }
  }

  const sanitized = output.join(' ');
  if (sanitized.length > maxLength) {
    return `${sanitized.slice(0, maxLength).trimEnd()}… [truncated; use --full-args]`;
  }

  return sanitized;
}

/**
 * Find all HAPI CLI processes (including current process)
 */
export async function findAllHappyProcesses(options: FindHappyProcessesOptions = {}): Promise<Array<{ pid: number, command: string, type: string }>> {
  try {
    const processes = await psList();
    const allProcesses: Array<{ pid: number, command: string, type: string }> = [];
    
    for (const proc of processes) {
      const cmd = proc.cmd || '';
      const name = proc.name || '';
      
      // Check if it's a HAPI process
      const isHappyBinary = name === 'hapi' || name === 'hapi.exe' || /\bhapi(\.exe)?\b/.test(cmd);
      // Dev mode: running via bun/node with src/index.ts (production uses compiled binary)
      const isDevMode = cmd.includes('src/index.ts');
      const isHappy = name.includes('happy') ||
                      name === 'node' && cmd.includes('happy-cli') ||
                      cmd.includes('happy-coder') ||
                      isHappyBinary ||
                      isDevMode;
      
      if (!isHappy) continue;

      // Classify process type
      let type = 'unknown';
      if (proc.pid === process.pid) {
        type = 'current';
      } else if (cmd.includes('--version')) {
        type = isDevMode ? 'dev-runner-version-check' : 'runner-version-check';
      } else if (cmd.includes('runner start-sync') || cmd.includes('runner start')) {
        type = isDevMode ? 'dev-runner' : 'runner';
      } else if (cmd.includes('--started-by runner')) {
        type = isDevMode ? 'dev-runner-spawned' : 'runner-spawned-session';
      } else if (cmd.includes('doctor')) {
        type = isDevMode ? 'dev-doctor' : 'doctor';
      } else if (cmd.includes('--yolo')) {
        type = 'dev-session';
      } else {
        type = isDevMode ? 'dev-related' : 'user-session';
      }

      const rawCommand = cmd || name;
      allProcesses.push({
        pid: proc.pid,
        command: options.fullArgs ? rawCommand : sanitizeProcessCommand(rawCommand),
        type
      });
    }

    return allProcesses;
  } catch (error) {
    return [];
  }
}

/**
 * Find all runaway HAPI CLI processes that should be killed
 */
export async function findRunawayHappyProcesses(): Promise<Array<{ pid: number, command: string }>> {
  const allProcesses = await findAllHappyProcesses();
  
  // Filter to just runaway processes (excluding current process)
  return allProcesses
    .filter(p => 
      p.pid !== process.pid && (
        p.type === 'runner' ||
        p.type === 'dev-runner' ||
        p.type === 'runner-spawned-session' ||
        p.type === 'dev-runner-spawned' ||
        p.type === 'runner-version-check' ||
        p.type === 'dev-runner-version-check'
      )
    )
    .map(p => ({ pid: p.pid, command: p.command }));
}

/**
 * Kill all runaway HAPI CLI processes
 */
export async function killRunawayHappyProcesses(): Promise<{ killed: number, errors: Array<{ pid: number, error: string }> }> {
  const runawayProcesses = await findRunawayHappyProcesses();
  return {
    killed: 0,
    errors: runawayProcesses.map(({ pid }) => ({
      pid,
      error: 'automatic PID/command-name cleanup is disabled; unjournaled processes require manual identity review'
    }))
  };
}
