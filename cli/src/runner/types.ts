/**
 * Runner-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for runner
 */
export interface TrackedSession {
  startedBy: 'runner' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  launchNonce?: string;
  birthToken?: string;
  pgid?: number;
}

export type RunnerState = 'starting' | 'reconciling' | 'ready' | 'ready-no-admission' | 'draining' | 'stopped';
