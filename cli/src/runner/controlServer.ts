/**
 * HTTP control server for runner management
 * Provides endpoints for listing sessions, stopping sessions, and runner shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession } from './types';
import { QuerySpawnSessionResult, SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';
import type { SignedManagedOutcome } from './managedOutcomeMailbox';

export const RUNNER_CONTROL_BODY_LIMIT_BYTES = 1024 * 1024;

export function startRunnerControlServer({
  getChildren,
  stopSession,
  spawnSession,
  querySpawnSession,
  requestShutdown,
  onHappySessionWebhook,
  onManagedOutcome,
  onNativeIdentity
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => Promise<boolean> | boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  querySpawnSession: (spawnRequestId: string) => Promise<QuerySpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => Promise<void> | void;
  onManagedOutcome: (envelope: SignedManagedOutcome) => Promise<{ acknowledged: boolean }>;
  onNativeIdentity?: (input: {
    launchNonce: string;
    pid: number;
    nativeResumeId: string;
    resumeProfileFingerprint: string;
  }) => Promise<{ acknowledged: boolean }>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false, // We use our own logger
      bodyLimit: RUNNER_CONTROL_BODY_LIMIT_BYTES
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any() // Metadata type from API
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      await onHappySessionWebhook(sessionId, metadata);

      return { status: 'ok' as const };
    });

    typed.post('/managed-outcome', {
      schema: {
        body: z.object({ envelope: z.any() }),
        response: { 200: z.object({ acknowledged: z.boolean() }) }
      }
    }, async (request) => {
      return await onManagedOutcome(request.body.envelope as SignedManagedOutcome);
    });

    typed.post('/native-identity', {
      schema: {
        body: z.object({
          launchNonce: z.string().uuid(),
          pid: z.number().int().positive(),
          nativeResumeId: z.string().min(1).max(4096),
          resumeProfileFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
        }),
        response: { 200: z.object({ acknowledged: z.boolean() }) }
      }
    }, async (request) => {
      if (!onNativeIdentity) return { acknowledged: false };
      return await onNativeIdentity(request.body);
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = await stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          spawnRequestId: z.string().uuid().optional(),
          directory: z.string(),
          sessionId: z.string().optional(),
          sessionType: z.enum(['simple', 'worktree']).optional(),
          worktreeName: z.string().optional()
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          202: z.object({
            success: z.literal(false),
            pending: z.literal(true),
            spawnRequestId: z.string().uuid()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { spawnRequestId, directory, sessionId, sessionType, worktreeName } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
      const result = await spawnSession({ spawnRequestId, directory, sessionId, sessionType, worktreeName });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };

        case 'pending':
          reply.code(202);
          return {
            success: false,
            pending: true,
            spawnRequestId: result.spawnRequestId
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    typed.post('/spawn-session-status', {
      schema: {
        body: z.object({ spawnRequestId: z.string().uuid() }),
        response: {
          200: z.discriminatedUnion('type', [
            z.object({ type: z.literal('success'), sessionId: z.string() }),
            z.object({ type: z.literal('pending'), spawnRequestId: z.string().uuid() }),
            z.object({ type: z.literal('not_found'), spawnRequestId: z.string().uuid() }),
            z.object({ type: z.literal('conflict'), spawnRequestId: z.string().uuid() }),
            z.object({ type: z.literal('requestToApproveDirectoryCreation'), directory: z.string() }),
            z.object({ type: z.literal('error'), errorMessage: z.string() })
          ])
        }
      }
    }, async (request) => {
      return await querySpawnSession(request.body.spawnRequestId);
    });

    // Stop runner
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop runner request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering runner shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
