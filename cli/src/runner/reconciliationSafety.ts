import type { RunnerReconcileConfig } from './privacyPreflight';
import { isRunnerReconciliationEnforcementEnabled } from './supportedTopology';

export function createRunnerReconciliationKillSwitchReader(options: {
  initialConfig: RunnerReconcileConfig;
  readConfig(): Promise<RunnerReconcileConfig>;
  assertOwnershipHealthy(): void;
  preflightEligible: boolean;
  ownershipEligible: boolean;
  launchContextEligible: boolean;
}): () => Promise<boolean> {
  const initialRoots = JSON.stringify(options.initialConfig.allowedWorkspaceRoots);
  const initiallyEligible = options.initialConfig.valid && isRunnerReconciliationEnforcementEnabled({
    configuredMode: options.initialConfig.mode,
    killSwitch: options.initialConfig.killSwitch,
    preflightEligible: options.preflightEligible,
    ownershipEligible: options.ownershipEligible,
    launchContextEligible: options.launchContextEligible
  });

  return async () => {
    try {
      const current = await options.readConfig();
      if (!initiallyEligible
        || !current.valid
        || JSON.stringify(current.allowedWorkspaceRoots) !== initialRoots) return true;
      // This synchronous assertion is intentionally the last fallible gate
      // before the caller proceeds to its signal-adjacent kill-switch check.
      options.assertOwnershipHealthy();
      return !isRunnerReconciliationEnforcementEnabled({
        configuredMode: current.mode,
        killSwitch: current.killSwitch,
        preflightEligible: options.preflightEligible,
        ownershipEligible: options.ownershipEligible,
        launchContextEligible: options.launchContextEligible
      });
    } catch {
      return true;
    }
  };
}
