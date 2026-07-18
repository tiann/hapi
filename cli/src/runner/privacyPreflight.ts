import { randomUUID } from 'node:crypto';
import { open, opendir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { RunnerState } from './types';
import type { ReconciliationMode } from './runnerConstants';

export type PrivacyProbe = { path: string; ok: true } | { path: string; ok: false; code: string };
export type WorkdirProbe = { ok: true; retainedRoot: string } | { ok: false; path: string; code: string };

export type RunnerReconcileConfig = {
  version: 1;
  mode: ReconciliationMode;
  killSwitch: boolean;
  allowedWorkspaceRoots: string[];
  valid: boolean;
};

export async function readRunnerReconcileConfig(home: string): Promise<RunnerReconcileConfig> {
  try {
    const parsed = JSON.parse(await readFile(join(resolve(home), 'runner-reconcile.json'), 'utf8')) as Record<string, unknown>;
    if (parsed.version !== 1 || !['off', 'report', 'enforce'].includes(String(parsed.mode))
      || typeof parsed.killSwitch !== 'boolean' || !Array.isArray(parsed.allowedWorkspaceRoots)
      || !parsed.allowedWorkspaceRoots.every((root) => typeof root === 'string' && root.length > 0)) {
      throw new Error('invalid reconciliation config');
    }
    return {
      version: 1,
      mode: parsed.mode as ReconciliationMode,
      killSwitch: parsed.killSwitch,
      allowedWorkspaceRoots: parsed.allowedWorkspaceRoots as string[],
      valid: true
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, mode: 'report', killSwitch: false, allowedWorkspaceRoots: [], valid: true };
    }
    return { version: 1, mode: 'report', killSwitch: true, allowedWorkspaceRoots: [], valid: false };
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function existingDirectoryAtOrAbove(path: string): Promise<string> {
  let candidate = resolve(path);
  for (;;) {
    try {
      const details = await stat(candidate);
      if (!details.isDirectory()) throw Object.assign(new Error(`${candidate} is not a directory`), { code: 'ENOTDIR' });
      return await realpath(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function probeDirectory(path: string): Promise<PrivacyProbe> {
  try {
    const directory = await opendir(path);
    try {
      await directory.read();
    } finally {
      await directory.close();
    }
    return { path, ok: true };
  } catch (error) {
    return { path, ok: false, code: errorCode(error) };
  }
}

export class PrivacyPreflight {
  private readonly allowedRoots = new Set<string>();

  async probeConfiguredRoots(roots: string[], runtimeEntrypoint: string): Promise<{
    enforceEligible: boolean;
    probes: PrivacyProbe[];
    failures: Array<{ path: string; code: string }>;
  }> {
    const probes: PrivacyProbe[] = [];
    const failures: Array<{ path: string; code: string }> = [];

    try {
      const runtimePath = await realpath(runtimeEntrypoint);
      const handle = await open(runtimePath, 'r');
      await handle.close();
      probes.push({ path: runtimePath, ok: true });
    } catch (error) {
      probes.push({ path: resolve(runtimeEntrypoint), ok: false, code: errorCode(error) });
    }

    if (roots.length === 0) failures.push({ path: '<allowedWorkspaceRoots>', code: 'EMPTY' });
    for (const root of roots) {
      try {
        const canonical = await existingDirectoryAtOrAbove(root);
        if (resolve(root) !== canonical) {
          const details = await stat(resolve(root));
          if (!details.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
        }
        const probe = await probeDirectory(canonical);
        probes.push(probe);
        if (probe.ok) this.allowedRoots.add(canonical);
      } catch (error) {
        probes.push({ path: resolve(root), ok: false, code: errorCode(error) });
      }
    }

    for (const probe of probes) if (!probe.ok) failures.push({ path: probe.path, code: probe.code });
    return { enforceEligible: failures.length === 0, probes, failures };
  }

  async ensureWorkdirAllowed(workdir: string, options: { exact?: boolean } = {}): Promise<WorkdirProbe> {
    const requested = resolve(workdir);
    if (options.exact) {
      try {
        const canonical = await realpath(requested);
        const probe = await probeDirectory(canonical);
        if (!probe.ok) return { ok: false, path: probe.path, code: probe.code };
        const retainedRoot = [...this.allowedRoots].find((root) => isWithin(canonical, root)) ?? canonical;
        this.allowedRoots.add(retainedRoot);
        return { ok: true, retainedRoot };
      } catch (error) {
        return { ok: false, path: requested, code: errorCode(error) };
      }
    }
    const existingAllowed = [...this.allowedRoots].find((root) => isWithin(requested, root));
    if (existingAllowed) {
      const probe = await probeDirectory(existingAllowed);
      return probe.ok ? { ok: true, retainedRoot: existingAllowed } : { ok: false, path: probe.path, code: probe.code };
    }

    try {
      const nearest = await existingDirectoryAtOrAbove(requested);
      const probe = await probeDirectory(nearest);
      if (!probe.ok) return { ok: false, path: probe.path, code: probe.code };
      this.allowedRoots.add(nearest);
      return { ok: true, retainedRoot: nearest };
    } catch (error) {
      return { ok: false, path: requested, code: errorCode(error) };
    }
  }
}

export interface SpawnAdmission {
  id: string;
  abortController: AbortController;
  phase: 'preparing' | 'reserved' | 'spawned' | 'committed';
  cleanup?: () => Promise<void>;
  terminateAndReap?: () => Promise<void>;
}

export class SpawnAdmissionController {
  state: RunnerState = 'starting';
  private readonly admissions = new Map<string, SpawnAdmission>();
  private operation: Promise<void> = Promise.resolve();

  async markReconciling(): Promise<void> {
    await this.serial(() => { this.state = 'reconciling'; });
  }

  async markReady(journalHealthy: boolean): Promise<void> {
    await this.serial(() => {
      if (this.state === 'draining' || this.state === 'stopped') return;
      this.state = journalHealthy ? 'ready' : 'ready-no-admission';
    });
  }

  async begin(cleanup?: () => Promise<void>): Promise<SpawnAdmission> {
    return this.serial(() => {
      if (this.state !== 'ready') throw new Error(`spawn admission is unavailable while runner is ${this.state}`);
      const admission: SpawnAdmission = {
        id: randomUUID(), abortController: new AbortController(), phase: 'preparing', cleanup
      };
      this.admissions.set(admission.id, admission);
      return admission;
    });
  }

  async markReserved(id: string): Promise<void> {
    await this.transition(id, 'preparing', 'reserved');
  }

  async markSpawned(id: string, terminateAndReap: () => Promise<void>): Promise<void> {
    const accepted = await this.serial(() => {
      const admission = this.requireAdmission(id);
      if (admission.phase !== 'reserved') throw new Error(`invalid spawn admission transition ${admission.phase} -> spawned`);
      if (this.state !== 'ready') {
        // Keep the admission addressable until the caller knows whether the
        // rejected child was actually reaped. If absence remains ambiguous,
        // the caller must still be able to preserve it as committed.
        return false;
      }
      admission.phase = 'spawned';
      admission.terminateAndReap = terminateAndReap;
      return true;
    });
    if (!accepted) {
      await terminateAndReap();
      throw new Error(`spawn admission is unavailable while runner is ${this.state}`);
    }
  }

  async commit(id: string): Promise<void> {
    await this.transition(id, 'spawned', 'committed');
  }

  async preserveAmbiguousSpawn(id: string): Promise<void> {
    await this.serial(() => {
      const admission = this.requireAdmission(id);
      if (!['reserved', 'spawned', 'committed'].includes(admission.phase)) {
        throw new Error(`cannot preserve ambiguous spawn from ${admission.phase}`);
      }
      // The child may already own provider state. Treat it as committed so a
      // concurrent drain cannot reap it or remove its live worktree merely
      // because post-spawn bookkeeping was inconclusive.
      admission.phase = 'committed';
    });
  }

  async cancel(id: string): Promise<void> {
    const admission = await this.serial(() => {
      const current = this.admissions.get(id);
      if (current) this.admissions.delete(id);
      return current;
    });
    admission?.abortController.abort();
    await admission?.cleanup?.();
  }

  async beginDrain(): Promise<void> {
    await this.serial(() => {
      if (this.state === 'stopped') return;
      this.state = 'draining';
      for (const admission of this.admissions.values()) admission.abortController.abort();
    });
  }

  async drain(deadlineMs: number, reapSpawned = true): Promise<{ committed: string[] }> {
    await this.beginDrain();
    const admissions = await this.serial(() => {
      if (this.state === 'stopped') return [];
      return [...this.admissions.values()];
    });

    const cleanup = admissions
      .filter((admission) => admission.phase === 'preparing')
      .map((admission) => admission.cleanup?.() ?? Promise.resolve());
    await Promise.race([
      Promise.allSettled(cleanup),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, Math.max(0, deadlineMs)))
    ]);

    for (const admission of admissions) {
      if (reapSpawned && admission.phase === 'spawned' && admission.terminateAndReap) await admission.terminateAndReap();
    }
    return { committed: admissions.filter((admission) => admission.phase === 'committed').map((admission) => admission.id) };
  }

  async markStopped(): Promise<void> {
    await this.serial(() => { this.state = 'stopped'; });
  }

  private requireAdmission(id: string): SpawnAdmission {
    const admission = this.admissions.get(id);
    if (!admission) throw new Error(`spawn admission ${id} is missing`);
    return admission;
  }

  private async transition(id: string, from: SpawnAdmission['phase'], to: SpawnAdmission['phase']): Promise<void> {
    await this.serial(() => {
      if (this.state !== 'ready') throw new Error(`spawn admission is unavailable while runner is ${this.state}`);
      const admission = this.requireAdmission(id);
      if (admission.phase !== from) throw new Error(`invalid spawn admission transition ${admission.phase} -> ${to}`);
      admission.phase = to;
    });
  }

  private async serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolveOperation) => { release = resolveOperation; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
