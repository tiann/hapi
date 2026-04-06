import { describe, expect, it } from 'vitest';
import { parseRateLimitText } from './rateLimitParser';

describe('parseRateLimitText', () => {
    it('returns null for non-JSON text', () => {
        expect(parseRateLimitText('Hello world')).toBeNull();
    });

    it('returns null for JSON that is not a rate_limit_event', () => {
        expect(parseRateLimitText('{"type":"other"}')).toBeNull();
    });

    it('converts allowed_warning to pipe-delimited warning text', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                resetsAt: 1774278000,
                rateLimitType: 'five_hour',
                utilization: 0.9,
                isUsingOverage: false,
                surpassedThreshold: 0.9,
            },
        }));

        expect(result).toEqual({
            suppress: false,
            message: {
                type: 'text',
                text: 'Claude AI usage limit warning|1774278000|90|five_hour',
            },
        });
    });

    it('includes seven_day rateLimitType', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                resetsAt: 1774850400,
                rateLimitType: 'seven_day',
                utilization: 0.85,
                surpassedThreshold: 0.75,
            },
        }));

        expect(result).toEqual({
            suppress: false,
            message: {
                type: 'text',
                text: 'Claude AI usage limit warning|1774850400|85|seven_day',
            },
        });
    });

    it('handles missing rateLimitType gracefully', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                resetsAt: 1774278000,
                utilization: 0.9,
            },
        }));

        expect(result).toEqual({
            suppress: false,
            message: {
                type: 'text',
                text: 'Claude AI usage limit warning|1774278000|90|',
            },
        });
    });

    it('converts rejected to existing pipe-delimited reached text', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'rejected',
                resetsAt: 1774278000,
                rateLimitType: 'five_hour',
                overageStatus: 'rejected',
                isUsingOverage: false,
            },
        }));

        expect(result).toEqual({
            suppress: false,
            message: {
                type: 'text',
                text: 'Claude AI usage limit reached|1774278000|five_hour',
            },
        });
    });

    it('suppresses allowed status', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed',
                resetsAt: 1774278000,
                utilization: 0.3,
            },
        }));

        expect(result).toEqual({ suppress: true });
    });

    it('suppresses unknown statuses to prevent raw JSON leaking', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'some_future_status',
                resetsAt: 1774278000,
            },
        }));

        expect(result).toEqual({ suppress: true });
    });

    it('handles wrapped { type: "output", data: { ... } } format', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'output',
            data: {
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'allowed_warning',
                    resetsAt: 1774278000,
                    utilization: 1,
                },
            },
        }));

        expect(result).toEqual({
            suppress: false,
            message: {
                type: 'text',
                text: 'Claude AI usage limit warning|1774278000|100|',
            },
        });
    });

    it('suppresses when resetsAt is missing to prevent raw JSON leak', () => {
        const result = parseRateLimitText(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'rejected',
            },
        }));

        expect(result).toEqual({ suppress: true });
    });
});
