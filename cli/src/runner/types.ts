/**
 * Runner-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for runner
 */
export interface TrackedSession {
  /** All immutable HAPI roots in this shared execution; primary ID remains the spawn ACK. */
  sharedSessions?: Record<string, Metadata>;
  startedBy: 'runner' | string;
  happySessionId?: string;
  /** HAPI row requested for this process generation before its webhook arrives. */
  requestedHappySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
}
