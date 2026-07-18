import fs from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import { join, win32 } from 'node:path';
import {
  AGENT_FLAVORS,
  PROVIDER_CAPABILITIES,
  PROVIDER_READINESS_READY_REFRESH_MS,
  PROVIDER_READINESS_RETRY_REFRESH_MS,
  type AgentFlavor,
  type ProviderReadiness,
  type ProviderReadinessMap
} from '@hapi/protocol';
import {
  getProviderCommand,
  getProviderProbeEnv,
  getUserHome,
  runBoundedProviderCommand,
  type ProviderCommandResult,
  type ProviderCommandSpec
} from './providerRuntime';

export const PROVIDER_PROBE_TIMEOUT_MS = 5_000;
export const PROVIDER_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
export const PROVIDER_PROBE_MAX_CONCURRENCY = 4;
export const PROVIDER_CREDENTIAL_FILE_MAX_BYTES = 64 * 1024;
export const PROVIDER_CREDENTIAL_FILE_TIMEOUT_MS = 1_000;

export type ProviderReadinessDependencies = {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    platform?: NodeJS.Platform;
  runCommand?: (spec: ProviderCommandSpec) => Promise<ProviderCommandResult>;
  readFile?: (path: string) => Promise<string>;
};

function cloneEntry(entry: ProviderReadiness): ProviderReadiness {
  return {
    ...entry,
    modes: [...entry.modes],
    models: [...entry.models],
    efforts: Object.fromEntries(
      Object.entries(entry.efforts).map(([model, efforts]) => [model, [...efforts]])
    )
  };
}

function cloneMap(map: ProviderReadinessMap): ProviderReadinessMap {
  return Object.fromEntries(
    Object.entries(map).map(([flavor, entry]) => [flavor, entry ? cloneEntry(entry) : entry])
  ) as ProviderReadinessMap;
}

function credentialFileError(message: string, code = 'EFTYPE'): Error {
  return Object.assign(new Error(message), { code });
}

function assertCredentialRegularFile(path: string, stats: Stats): void {
  if (stats.isSymbolicLink()) {
    throw credentialFileError(`credential path is a symbolic link: ${path}`);
  }
  if (!stats.isFile() || stats.nlink !== 1) {
    throw credentialFileError(`credential path is not one regular file link: ${path}`);
  }
}

function isSameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export type WindowsCredentialAncestorIdentity = {
  path: string;
  dev: number;
  ino: number;
};

function windowsCredentialAncestorPaths(path: string): string[] {
  const normalized = path.replaceAll('/', '\\');
  const root = win32.parse(normalized).root;
  const components = normalized.slice(root.length).split('\\').filter(Boolean);
  components.pop();

  const ancestors: string[] = [root];
  let current = root;
  for (const component of components) {
    current = win32.join(current, component);
    ancestors.push(current);
  }
  return ancestors;
}

export async function captureWindowsCredentialAncestorIdentities(
  path: string,
  lstatPath: (path: string) => Promise<Stats> = fs.lstat
): Promise<WindowsCredentialAncestorIdentity[]> {
  if (isUnsafeWindowsCredentialPath(path)) {
    throw credentialFileError('credential path uses an unsafe Windows namespace');
  }

  const identities: WindowsCredentialAncestorIdentity[] = [];
  for (const ancestorPath of windowsCredentialAncestorPaths(path)) {
    const stats = await lstatPath(ancestorPath);
    if (stats.isSymbolicLink()) {
      throw credentialFileError(`credential path ancestor is a symbolic link: ${ancestorPath}`);
    }
    if (!stats.isDirectory()) {
      throw credentialFileError(`credential path ancestor is not a directory: ${ancestorPath}`);
    }
    identities.push({ path: ancestorPath, dev: stats.dev, ino: stats.ino });
  }
  return identities;
}

export function assertSameWindowsCredentialAncestorIdentities(
  before: readonly WindowsCredentialAncestorIdentity[],
  after: readonly WindowsCredentialAncestorIdentity[]
): void {
  if (before.length !== after.length || before.some((identity, index) => {
    const current = after[index];
    return !current
      || identity.path !== current.path
      || identity.dev !== current.dev
      || identity.ino !== current.ino;
  })) {
    throw credentialFileError('credential path ancestor identity changed while reading');
  }
}

export class SingleFlightCredentialReadPool {
  private readonly operations = new Map<string, Promise<string>>();

  constructor(private readonly maxInFlight: number) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new RangeError('maxInFlight must be a positive integer');
    }
  }

  run(key: string, start: () => Promise<string>): Promise<string> {
    const existing = this.operations.get(key);
    if (existing) return existing;
    if (this.operations.size >= this.maxInFlight) {
      return Promise.reject(credentialFileError(
        'too many unresolved credential file readiness probes',
        'EBUSY'
      ));
    }

    const operation = Promise.resolve().then(start);
    this.operations.set(key, operation);
    const cleanup = () => {
      if (this.operations.get(key) === operation) this.operations.delete(key);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }
}

const credentialReadPool = new SingleFlightCredentialReadPool(4);

export function isUnsafeWindowsCredentialPath(path: string): boolean {
  const normalized = path.replaceAll('/', '\\');
  if (!win32.isAbsolute(normalized) || normalized.startsWith('\\\\')) return true;

  const root = win32.parse(normalized).root;
  const components = normalized.slice(root.length).split('\\').filter(Boolean);
  return components.some((component) => {
    const canonical = component.replace(/[ .]+$/gu, '');
    return canonical !== component
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(canonical)
      || canonical.includes(':');
  });
}

async function performCredentialTextFileRead(
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const beforeAncestors = platform === 'win32'
    ? await captureWindowsCredentialAncestorIdentities(path)
    : null;
  const beforeOpen = await fs.lstat(path);
  assertCredentialRegularFile(path, beforeOpen);
  const flags = fsConstants.O_RDONLY
    | (platform === 'win32' ? 0 : (fsConstants.O_NONBLOCK ?? 0))
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(path, flags);
  try {
    const stats = await handle.stat();
    assertCredentialRegularFile(path, stats);
    const afterOpen = await fs.lstat(path);
    assertCredentialRegularFile(path, afterOpen);
    if (!isSameFileIdentity(beforeOpen, stats) || !isSameFileIdentity(stats, afterOpen)) {
      throw credentialFileError('credential path identity changed while opening');
    }
    if (stats.size > PROVIDER_CREDENTIAL_FILE_MAX_BYTES) {
      throw credentialFileError('credential file exceeds readiness probe limit', 'EFBIG');
    }

    const buffer = Buffer.alloc(PROVIDER_CREDENTIAL_FILE_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > PROVIDER_CREDENTIAL_FILE_MAX_BYTES) {
      throw credentialFileError('credential file exceeds readiness probe limit', 'EFBIG');
    }
    const afterRead = await fs.lstat(path);
    assertCredentialRegularFile(path, afterRead);
    if (!isSameFileIdentity(stats, afterRead)) {
      throw credentialFileError('credential path identity changed while reading');
    }
    if (beforeAncestors) {
      const afterAncestors = await captureWindowsCredentialAncestorIdentities(path);
      assertSameWindowsCredentialAncestorIdentities(beforeAncestors, afterAncestors);
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readBoundedTextFile(
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (platform === 'win32' && isUnsafeWindowsCredentialPath(path)) {
    throw credentialFileError('credential path uses an unsafe Windows namespace');
  }

  const operationKey = platform === 'win32'
    ? `${platform}:${path.replaceAll('/', '\\').toLowerCase()}`
    : `${platform}:${path}`;
  // A timeout cannot cancel Node's filesystem request. Reuse the unresolved
  // request and cap distinct keys so repeated probes cannot multiply workers.
  const operation = credentialReadPool.run(
    operationKey,
    async () => await performCredentialTextFileRead(path, platform)
  );

  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<string>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(Object.assign(new Error('credential file readiness probe timed out'), { code: 'ETIMEDOUT' }));
        }, PROVIDER_CREDENTIAL_FILE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function versionArgs(flavor: AgentFlavor): string[] {
  return flavor === 'grok' ? ['version'] : ['--version'];
}

function authCheckFor(flavor: AgentFlavor): ProviderReadiness['authCheck'] {
  if (flavor === 'grok') return 'credential-file';
  if (flavor === 'claude' || flavor === 'codex' || flavor === 'cursor') return 'command';
  return 'unavailable';
}

function authStatusArgs(flavor: AgentFlavor): string[] | null {
  if (flavor === 'claude') return ['auth', 'status', '--json'];
  if (flavor === 'codex') return ['login', 'status'];
  if (flavor === 'cursor') return ['status', '--format', 'json'];
  return null;
}

export function parseProviderVersion(output: string): string | null {
  const match = /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output);
  return match?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core, prerelease] = value.split('-', 2);
    const parts = core!.split('.').map((part) => Number(part));
    return { parts, prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function explicitNegativeAuth(output: string): boolean {
  return /\b(?:not logged in|not authenticated|unauthenticated|logged out|signed out)\b/iu.test(output);
}

function explicitPositiveAuth(output: string): boolean {
  return /\b(?:logged in|authenticated|signed in)\b/iu.test(output) && !explicitNegativeAuth(output);
}

function findStructuredAuth(value: unknown, depth = 0): boolean | null {
  if (depth > 5 || value === null || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (['loggedIn', 'authenticated', 'isAuthenticated'].includes(key) && typeof child === 'boolean') {
      return child;
    }
    if (['status', 'authStatus', 'loginStatus'].includes(key) && typeof child === 'string') {
      if (explicitNegativeAuth(child)) return false;
      if (explicitPositiveAuth(child)) return true;
    }
  }
  for (const child of Object.values(value)) {
    const nested = findStructuredAuth(child, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function parseJsonAuth(output: string): boolean | null {
  try {
    return findStructuredAuth(JSON.parse(output));
  } catch {
    return null;
  }
}

function isCredentialRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['key', 'refresh_token'].some((key) => (
    typeof record[key] === 'string' && record[key].trim().length > 0
  ));
}

function hasGrokCredential(value: unknown): boolean {
  if (isCredentialRecord(value)) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  return Object.entries(value).some(([scope, record]) => (
    (/^https?:\/\//u.test(scope) || scope.includes('::')) && isCredentialRecord(record)
  ));
}

function commandFailed(result: ProviderCommandResult): boolean {
  return result.timedOut === true
    || result.outputLimitExceeded === true
    || result.errorCode !== undefined
    || result.exitCode === null;
}

export function isMissingProviderCommandResult(
  result: ProviderCommandResult,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (result.errorCode === 'ENOENT') return true;
  if (platform !== 'win32' || result.exitCode === 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /is not recognized as an internal or external command/iu.test(output)
    || /the system cannot find (?:the file|the path) specified/iu.test(output)
    || /不是内部或外部命令/u.test(output)
    || /系统找不到指定的(?:文件|路径)/u.test(output);
}

export class ProviderReadinessService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: (spec: ProviderCommandSpec) => Promise<ProviderCommandResult>;
  private readonly readFile: (path: string) => Promise<string>;
  private current: ProviderReadinessMap = {};
  private nextProbeGeneration = 0;
  private readonly appliedProbeGeneration: Partial<Record<AgentFlavor, number>> = {};
  private readonly shutdownController = new AbortController();
  private readonly inFlightProbes = new Map<AgentFlavor, Promise<ProviderReadiness>>();
  private activeProbeSlots = 0;
  private readonly probeWaiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];
  private shutdownPromise: Promise<void> | null = null;

  constructor(deps: ProviderReadinessDependencies = {}) {
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
    this.runCommand = deps.runCommand ?? runBoundedProviderCommand;
    this.readFile = deps.readFile ?? (async (path) => await readBoundedTextFile(path, this.platform));
  }

  private commandSpec(flavor: AgentFlavor, args: string[]): ProviderCommandSpec {
    return {
      command: getProviderCommand(flavor, this.env),
      args,
      env: getProviderProbeEnv(flavor, this.env),
      timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
      maxOutputBytes: PROVIDER_PROBE_MAX_OUTPUT_BYTES,
      signal: this.shutdownController.signal
    };
  }

  private shutdownError(): Error {
    return Object.assign(new Error('Provider readiness service is shut down'), {
      name: 'AbortError',
      code: 'ABORTED'
    });
  }

  private createProbeSlotRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeProbeSlots -= 1;

      while (this.probeWaiters.length > 0) {
        const waiter = this.probeWaiters.shift()!;
        if (this.shutdownController.signal.aborted) {
          waiter.reject(this.shutdownError());
          continue;
        }
        this.activeProbeSlots += 1;
        waiter.resolve(this.createProbeSlotRelease());
        break;
      }
    };
  }

  private acquireProbeSlot(): Promise<() => void> {
    if (this.shutdownController.signal.aborted) {
      return Promise.reject(this.shutdownError());
    }
    if (this.activeProbeSlots < PROVIDER_PROBE_MAX_CONCURRENCY) {
      this.activeProbeSlots += 1;
      return Promise.resolve(this.createProbeSlotRelease());
    }
    return new Promise((resolve, reject) => {
      this.probeWaiters.push({ resolve, reject });
    });
  }

  private async withProbeSlot<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireProbeSlot();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private entry(
    flavor: AgentFlavor,
    facts: Pick<ProviderReadiness, 'status' | 'installed' | 'authenticated' | 'version'>
  ): ProviderReadiness {
    const capabilities = PROVIDER_CAPABILITIES[flavor];
    return {
      ...facts,
      authCheck: authCheckFor(flavor),
      minimumVersion: capabilities.minimumVersion,
      modes: [...capabilities.modes],
      models: [...capabilities.models],
      efforts: Object.fromEntries(
        Object.entries(capabilities.efforts).map(([model, efforts]) => [model, [...efforts]])
      ),
      attachments: capabilities.attachments,
      resume: capabilities.resume,
      experimental: capabilities.experimental,
      checkedAt: this.now()
    };
  }

  private async probeGrokAuth(flavor: AgentFlavor, version: string): Promise<ProviderReadiness> {
    const grokHome = this.env.GROK_HOME?.trim() || join(getUserHome(this.env), '.grok');
    try {
      const credentialPath = join(grokHome, 'auth.json');
      if (this.platform === 'win32' && isUnsafeWindowsCredentialPath(credentialPath)) {
        throw credentialFileError('credential path uses an unsafe Windows namespace');
      }
      const contents = await this.readFile(credentialPath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        return this.entry(flavor, {
          status: 'probe-failed', installed: true, authenticated: null, version
        });
      }
      const authenticated = hasGrokCredential(parsed);
      return this.entry(flavor, {
        status: authenticated ? 'ready' : 'not-authenticated',
        installed: true,
        authenticated,
        version
      });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
      return this.entry(flavor, {
        status: code === 'ENOENT' ? 'not-authenticated' : 'probe-failed',
        installed: true,
        authenticated: code === 'ENOENT' ? false : null,
        version
      });
    }
  }

  private async probeCommandAuth(flavor: AgentFlavor, version: string, args: string[]): Promise<ProviderReadiness> {
    const result = await this.runCommand(this.commandSpec(flavor, args));
    const output = `${result.stdout}\n${result.stderr}`;
    if (commandFailed(result)) {
      return this.entry(flavor, {
        status: 'probe-failed', installed: true, authenticated: null, version
      });
    }

    let authenticated: boolean | null;
    if (flavor === 'codex') {
      authenticated = explicitNegativeAuth(output) ? false : explicitPositiveAuth(output) ? true : null;
    } else {
      authenticated = parseJsonAuth(result.stdout);
      if (authenticated === null && explicitNegativeAuth(output)) authenticated = false;
    }

    if (result.exitCode !== 0 && authenticated !== false) {
      return this.entry(flavor, {
        status: 'probe-failed', installed: true, authenticated: null, version
      });
    }
    if (authenticated === null) {
      return this.entry(flavor, {
        status: 'probe-failed', installed: true, authenticated: null, version
      });
    }
    return this.entry(flavor, {
      status: authenticated ? 'ready' : 'not-authenticated',
      installed: true,
      authenticated,
      version
    });
  }

  private async probeUncached(flavor: AgentFlavor): Promise<ProviderReadiness> {
    try {
      const versionResult = await this.runCommand(this.commandSpec(flavor, versionArgs(flavor)));
      if (isMissingProviderCommandResult(versionResult, this.platform)) {
        return this.entry(flavor, {
          status: 'not-installed', installed: false, authenticated: null, version: null
        });
      }
      if (commandFailed(versionResult) || versionResult.exitCode !== 0) {
        return this.entry(flavor, {
          status: 'probe-failed', installed: true, authenticated: null, version: null
        });
      }

      const version = parseProviderVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
      if (!version) {
        return this.entry(flavor, {
          status: 'probe-failed', installed: true, authenticated: null, version: null
        });
      }
      const minimumVersion = PROVIDER_CAPABILITIES[flavor].minimumVersion;
      if (minimumVersion && compareVersions(version, minimumVersion) < 0) {
        return this.entry(flavor, {
          status: 'unsupported-version', installed: true, authenticated: null, version
        });
      }

      if (flavor === 'grok') return await this.probeGrokAuth(flavor, version);
      const statusArgs = authStatusArgs(flavor);
      if (statusArgs) return await this.probeCommandAuth(flavor, version, statusArgs);
      return this.entry(flavor, {
        status: 'ready', installed: true, authenticated: null, version
      });
    } catch {
      return this.entry(flavor, {
        status: 'probe-failed', installed: true, authenticated: null, version: null
      });
    }
  }

  private probeAndApply(flavor: AgentFlavor): Promise<ProviderReadiness> {
    const existing = this.inFlightProbes.get(flavor);
    if (existing) return existing;
    if (this.shutdownController.signal.aborted) return Promise.reject(this.shutdownError());

    const generation = ++this.nextProbeGeneration;
    const operation = (async () => {
      let entry: ProviderReadiness;
      try {
        entry = await this.withProbeSlot(async () => await this.probeUncached(flavor));
      } catch (error) {
        if (!this.shutdownController.signal.aborted) throw error;
        entry = this.entry(flavor, {
          status: 'probe-failed', installed: true, authenticated: null, version: null
        });
      }

      if (!this.shutdownController.signal.aborted) {
        const appliedGeneration = this.appliedProbeGeneration[flavor] ?? 0;
        if (generation >= appliedGeneration) {
          const previous = this.current[flavor];
          const appliedEntry = previous && entry.checkedAt <= previous.checkedAt
            ? { ...entry, checkedAt: previous.checkedAt + 1 }
            : entry;
          this.appliedProbeGeneration[flavor] = generation;
          this.current = { ...this.current, [flavor]: appliedEntry };
        }
      }
      return cloneEntry(this.current[flavor] ?? entry);
    })();
    this.inFlightProbes.set(flavor, operation);
    const cleanup = () => {
      if (this.inFlightProbes.get(flavor) === operation) this.inFlightProbes.delete(flavor);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  async probe(flavor: AgentFlavor): Promise<ProviderReadiness> {
    return await this.probeAndApply(flavor);
  }

  async probeAll(): Promise<ProviderReadinessMap> {
    await Promise.all(AGENT_FLAVORS.map(async (flavor) => await this.probeAndApply(flavor)));
    return this.snapshot();
  }

  async refreshDue(): Promise<{ changed: boolean; snapshot: ProviderReadinessMap }> {
    const now = this.now();
    const due = AGENT_FLAVORS.filter((flavor) => {
      const entry = this.current[flavor];
      if (!entry) return true;
      if (now < entry.checkedAt) return true;
      const refreshAfter = entry.status === 'ready'
        ? PROVIDER_READINESS_READY_REFRESH_MS
        : PROVIDER_READINESS_RETRY_REFRESH_MS;
      return now - entry.checkedAt >= refreshAfter;
    });
    if (due.length === 0) return { changed: false, snapshot: this.snapshot() };

    await Promise.all(due.map(async (flavor) => await this.probeAndApply(flavor)));
    return { changed: true, snapshot: this.snapshot() };
  }

  snapshot(): ProviderReadinessMap {
    return cloneMap(this.current);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownController.abort();
    const error = this.shutdownError();
    for (const waiter of this.probeWaiters.splice(0)) waiter.reject(error);
    const operations = [...this.inFlightProbes.values()];
    this.shutdownPromise = (async () => {
      await Promise.allSettled(operations);
    })();
    return this.shutdownPromise;
  }
}
