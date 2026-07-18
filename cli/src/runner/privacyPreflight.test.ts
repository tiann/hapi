import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivacyPreflight, SpawnAdmissionController } from './privacyPreflight';
import { readRunnerReconcileConfig } from './privacyPreflight';

const paths: string[] = [];

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hapi-preflight-'));
  paths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('PrivacyPreflight', () => {
  it('reads report-only reconciliation config and fails closed on invalid config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hapi-privacy-config-'));
    paths.push(home);
    await writeFile(join(home, 'runner-reconcile.json'), JSON.stringify({
      version: 1, mode: 'report', killSwitch: false, allowedWorkspaceRoots: ['/tmp']
    }));
    await expect(readRunnerReconcileConfig(home)).resolves.toEqual({
      version: 1, mode: 'report', killSwitch: false, allowedWorkspaceRoots: ['/tmp'], valid: true
    });
    await writeFile(join(home, 'runner-reconcile.json'), JSON.stringify({ version: 2, mode: 'enforce' }));
    await expect(readRunnerReconcileConfig(home)).resolves.toMatchObject({
      mode: 'report', killSwitch: true, allowedWorkspaceRoots: [], valid: false
    });
  });
  it('blocks enforce mode when no workspace roots are configured', async () => {
    const preflight = new PrivacyPreflight();
    const result = await preflight.probeConfiguredRoots([], process.execPath);

    expect(result.enforceEligible).toBe(false);
    expect(result.failures).toEqual([{ path: '<allowedWorkspaceRoots>', code: 'EMPTY' }]);
  });

  it('probes roots without reading file contents and admits descendants', async () => {
    const root = await temp();
    await writeFile(join(root, 'secret.txt'), 'must-not-be-returned');
    const preflight = new PrivacyPreflight();
    const result = await preflight.probeConfiguredRoots([root], process.execPath);
    const canonicalRoot = await realpath(root);

    expect(result.enforceEligible).toBe(true);
    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({ path: canonicalRoot, ok: true })]));
    expect(await preflight.ensureWorkdirAllowed(join(root, 'future', 'child'))).toMatchObject({ ok: true, retainedRoot: canonicalRoot });
    expect(JSON.stringify(result)).not.toContain('must-not-be-returned');
  });

  it('just-in-time probes the nearest existing parent and rejects an unprobeable path', async () => {
    const root = await temp();
    const preflight = new PrivacyPreflight();
    const future = join(root, 'new', 'nested');
    const canonicalRoot = await realpath(root);

    expect(await preflight.ensureWorkdirAllowed(future)).toMatchObject({ ok: true, retainedRoot: canonicalRoot });
    expect(await preflight.ensureWorkdirAllowed(join(root, 'missing-after-delete'))).toMatchObject({ ok: true });
    expect(await preflight.ensureWorkdirAllowed('/dev/null/not-a-directory')).toMatchObject({ ok: false });
  });
});

describe('SpawnAdmissionController', () => {
  it('rejects admission when the journal is unhealthy', async () => {
    const controller = new SpawnAdmissionController();
    await controller.markReady(false);

    expect(controller.state).toBe('ready-no-admission');
    await expect(controller.begin()).rejects.toThrow(/admission/);
  });

  it('drain cancels preparation, runs cleanup, and rejects later spawns', async () => {
    const controller = new SpawnAdmissionController();
    await controller.markReady(true);
    let cleaned = false;
    const admission = await controller.begin(async () => { cleaned = true; });

    const snapshot = await controller.drain(100);

    expect(admission.abortController.signal.aborted).toBe(true);
    expect(cleaned).toBe(true);
    expect(snapshot.committed).toEqual([]);
    await expect(controller.begin()).rejects.toThrow(/draining/);
  });

  it('begins shutdown admission synchronously without reaping before ownership is checked', async () => {
    const controller = new SpawnAdmissionController();
    await controller.markReady(true);
    let cleaned = 0;
    let reaped = 0;
    const preparing = await controller.begin(async () => { cleaned += 1; });
    const spawned = await controller.begin();
    await controller.markReserved(spawned.id);
    await controller.markSpawned(spawned.id, async () => { reaped += 1; });

    await controller.beginDrain();

    expect(preparing.abortController.signal.aborted).toBe(true);
    expect(spawned.abortController.signal.aborted).toBe(true);
    expect(cleaned).toBe(0);
    expect(reaped).toBe(0);
    await expect(controller.begin()).rejects.toThrow(/draining/);

    await controller.drain(100, false);
    expect(cleaned).toBe(1);
    expect(reaped).toBe(0);
  });

  it('kills and reaps a spawned-but-uncommitted child during drain', async () => {
    const controller = new SpawnAdmissionController();
    await controller.markReady(true);
    const admission = await controller.begin();
    let reaped = false;
    await controller.markReserved(admission.id);
    await controller.markSpawned(admission.id, async () => { reaped = true; });

    await controller.drain(100);

    expect(reaped).toBe(true);
  });

  it('kills a child reported after drain won the spawn race', async () => {
    const controller = new SpawnAdmissionController();
    await controller.markReady(true);
    const admission = await controller.begin();
    await controller.markReserved(admission.id);
    await controller.drain(0);
    let reaped = false;

    await expect(controller.markSpawned(admission.id, async () => { reaped = true; })).rejects.toThrow(/draining/);
    expect(reaped).toBe(true);
  });

  it('cannot reopen admission after shutdown begins during startup', async () => {
    const controller = new SpawnAdmissionController();
    await controller.drain(0);
    await controller.markReady(true);

    expect(controller.state).toBe('draining');
  });

  it('preserves committed children in the shutdown snapshot', async () => {
    const controller = new SpawnAdmissionController();
    await controller.markReady(true);
    const admission = await controller.begin();
    await controller.markReserved(admission.id);
    await controller.markSpawned(admission.id, async () => { throw new Error('must not kill committed child'); });
    await controller.commit(admission.id);

    expect((await controller.drain(100)).committed).toEqual([admission.id]);
  });

  it('preserves an unproven reserved or spawned child as an ambiguous commit', async () => {
    for (const phase of ['reserved', 'spawned'] as const) {
      const controller = new SpawnAdmissionController();
      await controller.markReady(true);
      let cleaned = false;
      let reaped = false;
      const admission = await controller.begin(async () => { cleaned = true; });
      await controller.markReserved(admission.id);
      if (phase === 'spawned') {
        await controller.markSpawned(admission.id, async () => { reaped = true; });
      }

      await controller.preserveAmbiguousSpawn(admission.id);

      expect((await controller.drain(100)).committed).toEqual([admission.id]);
      expect(cleaned).toBe(false);
      expect(reaped).toBe(false);
    }
  });

  it('can preserve an unproven child after drain wins the mark-spawned race', async () => {
    const controller = new SpawnAdmissionController();
    await controller.markReady(true);
    const admission = await controller.begin();
    await controller.markReserved(admission.id);
    await controller.drain(0);
    let reaped = false;

    await expect(controller.markSpawned(admission.id, async () => {
      reaped = true;
    })).rejects.toThrow(/draining/);
    expect(reaped).toBe(true);

    await expect(controller.preserveAmbiguousSpawn(admission.id)).resolves.toBeUndefined();
    expect((await controller.drain(0)).committed).toEqual([admission.id]);
  });
});
