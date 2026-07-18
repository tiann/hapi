export type ManagedLaunchIdentity = {
  launchNonce: string;
  runnerInstanceId: string;
};

export type UntrackedManagedWebhookRoute =
  | 'buffer-managed'
  | 'accept-late-managed'
  | 'reject-managed'
  | 'register-external';

export function isValidManagedWebhookHostPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function hasManagedWebhookIdentity(input: {
  launchNonce?: unknown;
  runnerInstanceId?: unknown;
}): boolean {
  // Presence is enough to make a malformed payload managed-looking. Empty or
  // partial identity must not fall through to the external-session 200 path.
  return input.launchNonce !== undefined || input.runnerInstanceId !== undefined;
}

export function mustRetryManagedWebhook(
  route: UntrackedManagedWebhookRoute,
  managedWebhookAccepted: boolean
): boolean {
  return route === 'reject-managed'
    || (route === 'buffer-managed' && !managedWebhookAccepted);
}

export function classifyUntrackedManagedWebhook(input: {
  pendingIdentity?: ManagedLaunchIdentity;
  journalLaunchNonce?: string;
  managedWebhookAccepted: boolean;
  launchNonce?: string;
  runnerInstanceId?: string;
}): UntrackedManagedWebhookRoute {
  if (input.pendingIdentity) {
    return input.launchNonce === input.pendingIdentity.launchNonce
      && input.runnerInstanceId === input.pendingIdentity.runnerInstanceId
      ? 'buffer-managed'
      : 'reject-managed';
  }
  if (input.managedWebhookAccepted) return 'accept-late-managed';
  if (input.journalLaunchNonce
    || input.launchNonce !== undefined
    || input.runnerInstanceId !== undefined) return 'reject-managed';
  return 'register-external';
}
