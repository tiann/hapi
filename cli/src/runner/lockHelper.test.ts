import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryRunnerLock, startRunnerLockHelper, type RunnerLockHandle, type RunnerLockHelperCommand } from './lockHelper';

const tempDirs: string[] = [];
const handles: RunnerLockHandle[] = [];
const command: RunnerLockHelperCommand = {
  executable: 'bun',
  argsPrefix: [join(process.cwd(), 'src/index.ts'), '__hapi_internal_runner_lock_helper_v1']
};

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runner lock helper', () => {
  it('allows exactly one bundled-runtime helper to own a persistent lock inode without clang', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-runner-lock-'));
    tempDirs.push(dir);
    const lockPath = join(dir, 'runner.lock');

    const first = await startRunnerLockHelper({ command, lockPath });
    handles.push(first);
    const query = await queryRunnerLock({ command, lockPath });

    expect(query.locked).toBe(true);
    expect(query.holderPid).toBe(first.helperPid);
    expect(query.device).toBe(first.device);
    expect(query.inode).toBe(first.inode);
    await expect(startRunnerLockHelper({ command, lockPath })).rejects.toThrow(/already locked/);
  });

  it('releases the kernel lock when the owning descriptor process exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-runner-lock-'));
    tempDirs.push(dir);
    const lockPath = join(dir, 'runner.lock');

    const first = await startRunnerLockHelper({ command, lockPath });
    await first.close();
    const second = await startRunnerLockHelper({ command, lockPath });
    handles.push(second);

    expect(second.helperPid).not.toBe(first.helperPid);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'keeps the kernel lock while the parent handles a terminal %s',
    async (signal) => {
      const dir = await mkdtemp(join(tmpdir(), 'hapi-runner-lock-'));
      tempDirs.push(dir);
      const lockPath = join(dir, 'runner.lock');

      const first = await startRunnerLockHelper({ command, lockPath });
      handles.push(first);
      first.child.kill(signal);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(() => first.assertHealthy()).not.toThrow();
      await expect(startRunnerLockHelper({ command, lockPath })).rejects.toThrow(/already locked/);
    }
  );

  it('fails health checks if the persistent lock path is unlinked and replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-runner-lock-'));
    tempDirs.push(dir);
    const lockPath = join(dir, 'runner.lock');
    const first = await startRunnerLockHelper({ command, lockPath });
    handles.push(first);

    await unlink(lockPath);
    await writeFile(lockPath, 'replacement');

    expect(() => first.assertHealthy()).toThrow(/inode changed/);
  });
});
