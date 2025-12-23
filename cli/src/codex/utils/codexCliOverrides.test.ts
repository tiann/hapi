import { describe, expect, it } from 'vitest';
import { parseCodexCliOverrides } from './codexCliOverrides';

describe('parseCodexCliOverrides', () => {
    it('parses sandbox and approval flags', () => {
        expect(parseCodexCliOverrides(['-s', 'read-only', '-a', 'on-request'])).toEqual({
            sandbox: 'read-only',
            approvalPolicy: 'on-request'
        });
    });

    it('parses long flags with equals syntax', () => {
        expect(parseCodexCliOverrides(['--sandbox=workspace-write', '--ask-for-approval=never'])).toEqual({
            sandbox: 'workspace-write',
            approvalPolicy: 'never'
        });
    });

    it('parses convenience flags', () => {
        expect(parseCodexCliOverrides(['--full-auto'])).toEqual({
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request'
        });

        expect(parseCodexCliOverrides(['--dangerously-bypass-approvals-and-sandbox'])).toEqual({
            sandbox: 'danger-full-access',
            approvalPolicy: 'never'
        });
    });

    it('uses last value when flags repeat', () => {
        expect(parseCodexCliOverrides(['--sandbox', 'read-only', '--sandbox', 'danger-full-access'])).toEqual({
            sandbox: 'danger-full-access'
        });

        expect(parseCodexCliOverrides(['-a', 'untrusted', '-a', 'on-failure'])).toEqual({
            approvalPolicy: 'on-failure'
        });
    });

    it('ignores invalid values and stops at terminator', () => {
        expect(parseCodexCliOverrides(['--sandbox', 'nope', '--ask-for-approval', 'bad'])).toEqual({});

        expect(parseCodexCliOverrides(['-s', 'read-only', '--', '-a', 'never'])).toEqual({
            sandbox: 'read-only'
        });
    });
});
