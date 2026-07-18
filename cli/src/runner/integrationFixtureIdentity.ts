import { readProcessIdentity, type ProcessIdentity } from './processIdentity';

export type IntegrationFixtureProcessBinding = {
  pid: number;
  birthToken: string;
  pgid: number;
  executableRealpath: string;
  launchNonce: string;
  runnerInstanceId: string;
};

function hasExactFlag(argv: readonly string[], flag: string, value: string): boolean {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] === value;
}

export function matchesIntegrationFixtureProcess(
  binding: IntegrationFixtureProcessBinding,
  identity: ProcessIdentity | null
): boolean {
  return Boolean(identity
    && identity.evidenceSource === 'kernel'
    && identity.pid === binding.pid
    && identity.birthToken === binding.birthToken
    && identity.pgid === binding.pgid
    && identity.executableRealpath === binding.executableRealpath
    && hasExactFlag(identity.argv, '--hapi-launch-nonce', binding.launchNonce)
    && hasExactFlag(identity.argv, '--hapi-runner-instance', binding.runnerInstanceId));
}

export async function waitForExactIntegrationFixtureProcess(
  binding: IntegrationFixtureProcessBinding,
  options: {
    attempts?: number;
    intervalMs?: number;
    readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
    isAlive?: (pid: number) => boolean;
    sleep?: (delayMs: number) => Promise<void>;
  } = {}
): Promise<ProcessIdentity | null> {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 25;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) throw new Error('attempts must be a positive integer');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error('intervalMs must be a non-negative integer');
  const readIdentity = options.readIdentity ?? readProcessIdentity;
  const isAlive = options.isAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  });
  const sleep = options.sleep ?? (async (delayMs: number) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  });
  let lastIdentity: ProcessIdentity | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastIdentity = await readIdentity(binding.pid);
    if (matchesIntegrationFixtureProcess(binding, lastIdentity)) return lastIdentity;
    if (lastIdentity && lastIdentity.evidenceSource !== 'ps') {
      throw new Error(`Fixture PID ${binding.pid} has a different kernel identity\n`
        + `binding=${JSON.stringify(binding)}\nidentity=${JSON.stringify(lastIdentity)}`);
    }
    if (!isAlive(binding.pid)) return null;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }

  throw new Error(`Exact kernel identity remained unavailable for fixture PID ${binding.pid}\n`
    + `binding=${JSON.stringify(binding)}\nidentity=${JSON.stringify(lastIdentity)}`);
}
