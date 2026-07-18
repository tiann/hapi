import {
  AGENT_FLAVORS,
  isCcApiEffortAllowedForModel,
  isClaudeDeepSeekEffortAllowedForModel,
  resolveProviderSelectionEffort,
  resolveProviderSelectionModel,
  resolveProviderSelectionMode,
  type AgentFlavor
} from '@hapi/protocol';
import { PERMISSION_MODES } from '@hapi/protocol/modes';
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes';

export function resolveRunnerAgentFlavor(agent: string): AgentFlavor | null {
  return (AGENT_FLAVORS as readonly string[]).includes(agent)
    ? agent as AgentFlavor
    : null;
}

export function resolveEffectiveRunnerModel(
  agent: string,
  model: string | null | undefined
): string | undefined {
  const flavor = resolveRunnerAgentFlavor(agent);
  if (!flavor) return model?.trim() || undefined;
  const effectiveModel = resolveProviderSelectionModel(flavor, model);
  return effectiveModel && effectiveModel !== 'auto' ? effectiveModel : undefined;
}

export function resolveRunnerReadinessModel(
  agent: string,
  model: string | undefined
): string | undefined {
  return agent === 'opencode' ? undefined : model;
}

export function resolveCanonicalRunnerEffortSelection(
  agent: string,
  options: SpawnSessionOptions
): string | undefined {
  const flavor = resolveRunnerAgentFlavor(agent);
  if (!flavor) return options.effort?.trim() || undefined;

  const selectedEffort = agent === 'codex'
    ? options.modelReasoningEffort
    : options.effort;
  const effectiveEffort = resolveProviderSelectionEffort(flavor, selectedEffort);
  if (!effectiveEffort || effectiveEffort === 'auto' || (agent === 'codex' && effectiveEffort === 'default')) {
    return undefined;
  }
  return effectiveEffort;
}

export function resolveEffectiveRunnerEffort(
  agent: string,
  options: SpawnSessionOptions
): string | undefined {
  const effectiveEffort = resolveCanonicalRunnerEffortSelection(agent, options);
  if (!effectiveEffort) return undefined;
  if (
    agent === 'cc-api'
    && !isCcApiEffortAllowedForModel(
      resolveEffectiveRunnerModel(agent, options.model),
      effectiveEffort,
      { allowUnlistedModel: Boolean(options.resumeSessionId) }
    )
  ) return undefined;
  if (
    agent === 'claude-deepseek'
    && !isClaudeDeepSeekEffortAllowedForModel(
      resolveEffectiveRunnerModel(agent, options.model),
      effectiveEffort
    )
  ) return undefined;
  return effectiveEffort;
}

export function resolveCanonicalRunnerPermissionSelection(
  agent: string,
  options: SpawnSessionOptions
): string {
  const selectedMode = options.permissionMode?.trim();
  if (selectedMode) return selectedMode;
  const flavor = resolveRunnerAgentFlavor(agent);
  return flavor
    ? resolveProviderSelectionMode(flavor, undefined, options.yolo === true)
    : options.yolo === true ? 'yolo' : 'default';
}

export function resolveEffectiveRunnerPermissionMode(
  agent: string,
  options: SpawnSessionOptions,
  yolo = options.yolo === true
): string {
  const selectedMode = options.permissionMode?.trim();
  if (selectedMode && (PERMISSION_MODES as readonly string[]).includes(selectedMode)) {
    return selectedMode;
  }
  const flavor = resolveRunnerAgentFlavor(agent);
  return flavor
    ? resolveProviderSelectionMode(flavor, undefined, yolo)
    : yolo ? 'yolo' : 'default';
}

export function resolveEffectiveRunnerServiceTier(
  agent: string,
  serviceTier: string | null | undefined
): string | undefined {
  if (agent !== 'codex') return undefined;
  const selected = serviceTier?.trim();
  return selected && selected !== 'default' ? selected : undefined;
}
