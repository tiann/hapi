import { describe, expect, it } from 'vitest';

import {
  classifyUntrackedManagedWebhook,
  hasManagedWebhookIdentity,
  isValidManagedWebhookHostPid,
  mustRetryManagedWebhook
} from './managedWebhookRouting';

describe('classifyUntrackedManagedWebhook', () => {
  const pendingIdentity = {
    launchNonce: 'launch-current',
    runnerInstanceId: 'runner-current'
  };

  it('buffers only the exact current pending launch identity', () => {
    expect(classifyUntrackedManagedWebhook({
      pendingIdentity,
      managedWebhookAccepted: false,
      launchNonce: 'launch-current',
      runnerInstanceId: 'runner-current'
    })).toBe('buffer-managed');
    expect(classifyUntrackedManagedWebhook({
      pendingIdentity,
      managedWebhookAccepted: false,
      launchNonce: 'launch-wrong',
      runnerInstanceId: 'runner-current'
    })).toBe('reject-managed');
    expect(classifyUntrackedManagedWebhook({
      pendingIdentity,
      managedWebhookAccepted: false,
      launchNonce: 'launch-current',
      runnerInstanceId: 'runner-wrong'
    })).toBe('reject-managed');
  });

  it('rejects unaccepted managed-looking or journal-bound webhooks before external registration', () => {
    expect(classifyUntrackedManagedWebhook({
      managedWebhookAccepted: false,
      launchNonce: 'unknown-managed-launch',
      runnerInstanceId: 'runner-old'
    })).toBe('reject-managed');
    expect(classifyUntrackedManagedWebhook({
      managedWebhookAccepted: false,
      journalLaunchNonce: 'known-journal-launch'
    })).toBe('reject-managed');
  });

  it('distinguishes accepted late managed webhooks from genuine external sessions', () => {
    expect(classifyUntrackedManagedWebhook({
      managedWebhookAccepted: true,
      launchNonce: 'known-launch',
      runnerInstanceId: 'runner-old'
    })).toBe('accept-late-managed');
    expect(classifyUntrackedManagedWebhook({
      managedWebhookAccepted: false
    })).toBe('register-external');
  });

  it('never acknowledges an early exact webhook before durable settlement', () => {
    expect(mustRetryManagedWebhook('buffer-managed', false)).toBe(true);
    expect(mustRetryManagedWebhook('reject-managed', false)).toBe(true);
    expect(mustRetryManagedWebhook('reject-managed', true)).toBe(true);
    expect(mustRetryManagedWebhook('buffer-managed', true)).toBe(false);
    expect(mustRetryManagedWebhook('accept-late-managed', true)).toBe(false);
    expect(mustRetryManagedWebhook('register-external', false)).toBe(false);
  });

  it('rejects managed identity even when no journal-backed PID mapping exists', () => {
    expect(classifyUntrackedManagedWebhook({
      managedWebhookAccepted: false,
      launchNonce: 'launch-without-local-journal',
      runnerInstanceId: 'runner-without-local-journal'
    })).toBe('reject-managed');
    expect(mustRetryManagedWebhook('reject-managed', false)).toBe(true);
  });

  it('distinguishes malformed managed hostPid payloads from ignorable external reports', () => {
    expect(isValidManagedWebhookHostPid(4242)).toBe(true);
    expect(isValidManagedWebhookHostPid(0)).toBe(false);
    expect(isValidManagedWebhookHostPid(undefined)).toBe(false);
    expect(isValidManagedWebhookHostPid('4242')).toBe(false);

    expect(hasManagedWebhookIdentity({ launchNonce: 'launch-only' })).toBe(true);
    expect(hasManagedWebhookIdentity({ runnerInstanceId: 'runner-only' })).toBe(true);
    expect(hasManagedWebhookIdentity({ launchNonce: '', runnerInstanceId: '' })).toBe(true);
    expect(hasManagedWebhookIdentity({})).toBe(false);
  });
});
