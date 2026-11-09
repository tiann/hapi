/**
 * Stream-json transport, for agy releases without `agy acp` (< 1.5.0), an agy
 * whose version cannot be read, and an `agy acp` that fails to start.
 *
 * Removal: when agy < 1.5.0 is no longer supported, delete this directory and
 * its branches in ../agyRemoteLauncher.ts. Nothing else imports from here.
 * Rendering of stored agy transcripts in the web and native apps does not
 * depend on this directory.
 */
import { logger } from '@/ui/logger';
import type { AgySession } from '../session';
import { agyHeadlessDriver } from './agyHeadlessDriver';
import { needsStreamJson, type AgyVersionProbe } from './agyVersion';

type AgyRemoteLaunch = (session: AgySession) => Promise<'switch' | 'exit'>;

async function runStreamJsonAgy(session: AgySession, reason: string): Promise<'switch' | 'exit'> {
    logger.warn(`[agy] using the stream-json transport: ${reason}`);
    session.sendSessionEvent({
        type: 'message',
        message: `Antigravity runs without agy acp (${reason}); Steer is not available.`
    });
    // A session that ran on `agy acp` before must not keep the marker that
    // enables steering.
    session.client.updateMetadata((metadata) => {
        if (metadata.agyProtocol === undefined) return metadata;
        const { agyProtocol: _acp, ...rest } = metadata;
        return rest;
    });
    return agyHeadlessDriver(session);
}

export async function selectLegacyStreamJsonAgy(probe?: AgyVersionProbe): Promise<AgyRemoteLaunch | null> {
    const choice = await needsStreamJson(probe);
    if (!choice.streamJson) {
        logger.debug(`[agy] using agy acp: ${choice.reason}`);
        return null;
    }
    return (session) => runStreamJsonAgy(session, choice.reason);
}

export async function runStreamJsonAgyAfterAcpFailure(session: AgySession, error: Error): Promise<'switch' | 'exit'> {
    return runStreamJsonAgy(session, `agy acp failed to start: ${error.message}`);
}
