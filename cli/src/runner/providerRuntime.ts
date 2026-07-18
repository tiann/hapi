import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { AgentFlavor } from '@hapi/protocol';
import { prependPathEntry } from '@/agent/sessionEnvironment';

const MANAGED_CODEX_SHARED_ENTRY_NAMES = [
  'auth.json',
  'config.toml',
  'AGENTS.md',
  'plugins',
  'skills',
  'superpowers',
  'memories',
  'memories_extensions',
  'rules',
  'computer-use',
  'vendor_imports',
  'models_cache.json'
] as const;

export const CLAUDE_DEEPSEEK_AGENT = 'claude-deepseek';
export const CLAUDE_ARK_AGENT = 'claude-ark';
export const CLAUDE_API_AGENT = 'cc-api';
export const HERMES_MOA_AGENT = 'hermes-moa';

export type ProviderCommandSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};

export type ProviderCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
};

export function getUserHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || os.homedir();
}

export function getDefaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(getUserHome(env), '.codex');
}

export function getManagedCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HAPI_CODEX_HOME?.trim();
  if (override) return override;

  const hapiHome = env.HAPI_HOME?.trim() || join(getUserHome(env), '.hapi');
  return join(hapiHome, 'codex-home');
}

export function getClaudeDeepSeekWrapperPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAPI_CLAUDE_DEEPSEEK_PATH?.trim() || join(getUserHome(env), '.local', 'bin', 'claude-deepseek');
}

export function getClaudeArkWrapperPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAPI_CLAUDE_ARK_PATH?.trim() || join(getUserHome(env), '.local', 'bin', 'claude-ark');
}

export function getClaudeApiWrapperPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAPI_CLAUDE_API_PATH?.trim() || join(getUserHome(env), '.local', 'bin', 'claude-api');
}

export function getHermesWrapperPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAPI_HERMES_PATH?.trim() || join(getUserHome(env), '.local', 'bin', 'hermes');
}

export function isClaudeDeepSeekAgent(agent: string | undefined): boolean {
  return agent === CLAUDE_DEEPSEEK_AGENT;
}

export function isClaudeArkAgent(agent: string | undefined): boolean {
  return agent === CLAUDE_ARK_AGENT;
}

export function isClaudeApiAgent(agent: string | undefined): boolean {
  return agent === CLAUDE_API_AGENT;
}

export function isHermesMoaAgent(agent: string | undefined): boolean {
  return agent === HERMES_MOA_AGENT;
}

export function isClaudeFamilyAgent(agent: string | undefined): boolean {
  return agent === 'claude' || isClaudeDeepSeekAgent(agent) || isClaudeArkAgent(agent) || isClaudeApiAgent(agent);
}

export function getProviderCommand(flavor: AgentFlavor, env: NodeJS.ProcessEnv = process.env): string {
  switch (flavor) {
    case 'claude':
      return env.HAPI_CLAUDE_PATH?.trim() || 'claude';
    case 'claude-deepseek':
      return getClaudeDeepSeekWrapperPath(env);
    case 'claude-ark':
      return getClaudeArkWrapperPath(env);
    case 'cc-api':
      return getClaudeApiWrapperPath(env);
    case 'codex':
      return 'codex';
    case 'agy':
      return 'agy';
    case 'grok':
      return 'grok';
    case 'opencode':
      return 'opencode';
    case 'cursor':
      return env.HAPI_CURSOR_PATH?.trim() || 'cursor-agent';
    case 'hermes-moa':
      return getHermesWrapperPath(env);
  }
}

export function getRunnerBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const localBin = join(getUserHome(env), '.local', 'bin');
  return { PATH: prependPathEntry(env.PATH, localBin) };
}

export function getRunnerAgentEnv(agent: string | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (agent === 'claude') {
    const override = env.HAPI_CLAUDE_PATH?.trim();
    return override ? { HAPI_CLAUDE_PATH: override } : {};
  }
  if (agent === 'codex') {
    return { CODEX_HOME: getManagedCodexHome(env) };
  }
  if (agent === 'cursor') {
    const override = env.HAPI_CURSOR_PATH?.trim();
    return override ? { HAPI_CURSOR_PATH: override } : {};
  }
  if (isClaudeDeepSeekAgent(agent)) {
    return { HAPI_CLAUDE_PATH: getClaudeDeepSeekWrapperPath(env) };
  }
  if (isClaudeArkAgent(agent)) {
    return { HAPI_CLAUDE_PATH: getClaudeArkWrapperPath(env) };
  }
  if (isClaudeApiAgent(agent)) {
    return { HAPI_CLAUDE_PATH: getClaudeApiWrapperPath(env) };
  }
  if (isHermesMoaAgent(agent)) {
    return { HAPI_HERMES_PATH: getHermesWrapperPath(env) };
  }
  return {};
}

function getAllowedProviderPrefixes(agent: string): string[] {
  return agent === 'codex'
    ? ['OPENAI_', 'CODEX_']
    : agent === 'agy'
      ? ['AGY_', 'ANTIGRAVITY_', 'GOOGLE_', 'GEMINI_']
      : agent === 'grok'
        ? ['GROK_']
        : agent === 'cursor'
          ? ['CURSOR_']
          : agent === 'opencode'
            ? ['OPENCODE_']
            : isHermesMoaAgent(agent)
              ? ['HERMES_']
              : isClaudeArkAgent(agent)
                ? ['ANTHROPIC_', 'CLAUDE_', 'ARK_', 'VOLCENGINE_']
                : ['ANTHROPIC_', 'CLAUDE_'];
}

export function getSanitizedRunnerChildEnv(agent: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const output = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const providerPrefixes = [
    'OPENAI_', 'CODEX_', 'ANTHROPIC_', 'CLAUDE_', 'AGY_', 'ANTIGRAVITY_',
    'GOOGLE_', 'GEMINI_', 'GROK_', 'ARK_', 'VOLCENGINE_', 'HERMES_',
    'CURSOR_', 'OPENCODE_'
  ];
  const allowedPrefixes = getAllowedProviderPrefixes(agent);
  for (const key of Object.keys(output)) {
    if (providerPrefixes.some((prefix) => key.startsWith(prefix))
      && !allowedPrefixes.some((prefix) => key.startsWith(prefix))) delete output[key];
  }
  delete output.HAPI_LAUNCH_NONCE;
  delete output.HAPI_RUNNER_INSTANCE_ID;
  delete output.HAPI_MANAGED_OUTCOME_FD;
  delete output.HAPI_RESUME_PROFILE_FINGERPRINT;
  delete output.HAPI_EXPECTED_NATIVE_RESUME_ID;
  delete output.HAPI_CLAUDE_PATH;
  delete output.HAPI_HERMES_PATH;
  delete output.HAPI_CURSOR_PATH;
  delete output.HAPI_CODEX_HOME;
  return output;
}

const PROVIDER_PROBE_RUNTIME_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'ComSpec', 'PATHEXT'
]);

export function getProviderProbeEnv(
  flavor: AgentFlavor,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const providerPrefixes = getAllowedProviderPrefixes(flavor);
  const sanitized = getSanitizedRunnerChildEnv(flavor, env);
  const essentials = Object.fromEntries(Object.entries(sanitized).filter(([key]) =>
    PROVIDER_PROBE_RUNTIME_KEYS.has(key)
    || providerPrefixes.some((prefix) => key.startsWith(prefix))
  ));
  return {
    ...essentials,
    ...getRunnerBaseEnv(env),
    ...(flavor === 'codex'
      ? { CODEX_HOME: env.HAPI_CODEX_HOME?.trim() || getDefaultCodexHome(env) }
      : getRunnerAgentEnv(flavor, env))
  };
}

export function getManagedCodexBootstrapEntryNames(): readonly string[] {
  return MANAGED_CODEX_SHARED_ENTRY_NAMES;
}

async function linkCodexSharedEntryIfMissing(defaultCodexHome: string, managedCodexHome: string, entryName: string): Promise<void> {
  const source = join(defaultCodexHome, entryName);
  const destination = join(managedCodexHome, entryName);
  const sourceStats = await fs.lstat(source).catch(() => null);
  if (!sourceStats) return;

  const destinationStats = await fs.lstat(destination).catch(() => null);
  if (destinationStats) return;

  const symlinkType = sourceStats.isDirectory()
    ? (process.platform === 'win32' ? 'junction' : 'dir')
    : 'file';
  await fs.symlink(source, destination, symlinkType).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

export async function ensureManagedCodexHome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const managedCodexHome = getManagedCodexHome(env);
  await fs.mkdir(managedCodexHome, { recursive: true, mode: 0o700 });

  const defaultCodexHome = getDefaultCodexHome(env);
  if (managedCodexHome === defaultCodexHome) return managedCodexHome;

  await Promise.all(MANAGED_CODEX_SHARED_ENTRY_NAMES.map((entryName) =>
    linkCodexSharedEntryIfMissing(defaultCodexHome, managedCodexHome, entryName)
  ));
  return managedCodexHome;
}

const PROVIDER_COMMAND_TERMINATION_GRACE_MS = 250;
const PROVIDER_COMMAND_FORCE_SETTLE_MS = 1_000;

function signalProviderCommandTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        });
        killer.unref();
      } catch {
        // Direct-child fallback below still prevents an unbounded command wait.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The process may already be terminal.
    }
    return;
  }

  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back when the group disappeared between the probe and signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already be terminal.
  }
}

export async function runBoundedProviderCommand(spec: ProviderCommandSpec): Promise<ProviderCommandResult> {
  return await new Promise((resolve) => {
    if (spec.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: '', errorCode: 'ABORTED' });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timeout: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    let terminationResult: Omit<ProviderCommandResult, 'stdout' | 'stderr'> | null = null;

    const finish = (result: Omit<ProviderCommandResult, 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      if (abortListener) spec.signal?.removeEventListener('abort', abortListener);
      resolve({ ...result, stdout, stderr });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        windowsHide: true
      });
    } catch (error) {
      finish({
        exitCode: null,
        errorCode: error instanceof Error && 'code' in error ? String(error.code) : 'SPAWN_ERROR'
      });
      return;
    }

    const terminate = (result: Omit<ProviderCommandResult, 'stdout' | 'stderr'>) => {
      if (settled || terminationResult) return;
      terminationResult = result;
      if (timeout) clearTimeout(timeout);
      signalProviderCommandTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        signalProviderCommandTree(child, 'SIGKILL');
        forceSettleTimer = setTimeout(() => finish(result), PROVIDER_COMMAND_FORCE_SETTLE_MS);
        forceSettleTimer.unref();
      }, PROVIDER_COMMAND_TERMINATION_GRACE_MS);
      forceKillTimer.unref();
    };

    const append = (stream: 'stdout' | 'stderr', chunk: unknown) => {
      if (settled || terminationResult) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, spec.maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const text = buffer.subarray(0, remaining).toString('utf8');
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      }
      outputBytes += buffer.byteLength;
      if (outputBytes > spec.maxOutputBytes) {
        terminate({ exitCode: null, outputLimitExceeded: true });
      }
    };

    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (!terminationResult) finish({ exitCode: null, errorCode: error.code ?? 'SPAWN_ERROR' });
    });
    child.once('close', (code) => {
      if (terminationResult) return;
      finish({ exitCode: code });
    });

    if (spec.signal) {
      abortListener = () => terminate({ exitCode: null, errorCode: 'ABORTED' });
      spec.signal.addEventListener('abort', abortListener, { once: true });
      if (spec.signal.aborted) abortListener();
    }

    if (!terminationResult) {
      timeout = setTimeout(() => {
        terminate({ exitCode: null, timedOut: true });
      }, spec.timeoutMs);
      timeout.unref();
    }
  });
}
