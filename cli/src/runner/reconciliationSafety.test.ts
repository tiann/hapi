import { describe, expect, it } from 'vitest';

import { createRunnerReconciliationKillSwitchReader } from './reconciliationSafety';

describe('createRunnerReconciliationKillSwitchReader', () => {
  it('reloads config and fails closed when enforcement is revoked', async () => {
    let current = {
      version: 1 as const,
      mode: 'enforce' as const,
      killSwitch: false,
      allowedWorkspaceRoots: ['/tmp/project'],
      valid: true
    };
    const read = createRunnerReconciliationKillSwitchReader({
      initialConfig: current,
      readConfig: async () => current,
      assertOwnershipHealthy: () => undefined,
      preflightEligible: true,
      ownershipEligible: true,
      launchContextEligible: true
    });

    await expect(read()).resolves.toBe(false);
    current = { ...current, killSwitch: true };
    await expect(read()).resolves.toBe(true);
  });

  it('fails closed on helper loss, invalid config, or changed preflight roots', async () => {
    const initialConfig = {
      version: 1 as const,
      mode: 'enforce' as const,
      killSwitch: false,
      allowedWorkspaceRoots: ['/tmp/project'],
      valid: true
    };
    let healthy = true;
    let current = { ...initialConfig };
    const read = createRunnerReconciliationKillSwitchReader({
      initialConfig,
      readConfig: async () => current,
      assertOwnershipHealthy: () => {
        if (!healthy) throw new Error('runner lock helper exited');
      },
      preflightEligible: true,
      ownershipEligible: true,
      launchContextEligible: true
    });

    healthy = false;
    await expect(read()).resolves.toBe(true);
    healthy = true;
    current = { ...current, valid: false };
    await expect(read()).resolves.toBe(true);
    current = { ...initialConfig, allowedWorkspaceRoots: ['/tmp/other'] };
    await expect(read()).resolves.toBe(true);
  });
});
