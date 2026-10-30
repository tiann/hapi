import { uptime } from 'node:os';

/** OS-wide clock; whole seconds also match Bun's uptime precision across processes. */
export function monotonicTimeMs(): number {
    return Math.floor(uptime()) * 1000;
}

export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    let maxDelayRet = minDelay + ((maxDelay - minDelay) / maxFailureCount) * Math.min(currentFailureCount, maxFailureCount);
    return Math.round(Math.random() * maxDelayRet);
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export function createBackoff(
    opts?: {
        onError?: (e: any, failuresCount: number) => void,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 50;
        while (true) {
            try {
                return await callback();
            } catch (e) {
                if (currentFailureCount < maxFailureCount) {
                    currentFailureCount++;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                let waitForRequest = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                await delay(waitForRequest);
            }
        }
    };
}

export let backoff = createBackoff();

/**
 * Options for withRetry function
 */
export type RetryOptions = {
    /** Maximum number of retry attempts. Default: unlimited */
    maxAttempts?: number
    /** Minimum delay between retries in ms. Default: 1000 */
    minDelay?: number
    /** Maximum delay between retries in ms. Default: 30000 */
    maxDelay?: number
    /** Function to determine if error is retryable. Default: retry all errors */
    shouldRetry?: (error: unknown) => boolean
    /** Callback when a retry is about to happen */
    onRetry?: (error: unknown, attempt: number, nextDelayMs: number) => void
}

/**
 * Execute a function with retry logic and exponential backoff
 *
 * Unlike createBackoff, this function:
 * - Supports a shouldRetry predicate to skip non-retryable errors
 * - Has sensible defaults for runner-style long-running processes
 * - Uses clearer exponential backoff (2^n with jitter)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions
): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? Infinity
    const minDelay = options?.minDelay ?? 1000
    const maxDelay = options?.maxDelay ?? 30000
    const shouldRetry = options?.shouldRetry ?? (() => true)
    const onRetry = options?.onRetry

    let attempt = 0

    while (true) {
        try {
            return await fn()
        } catch (error) {
            attempt++

            // Check if we should retry this error
            if (!shouldRetry(error)) {
                throw error
            }

            // Check if we've exceeded max attempts
            if (attempt >= maxAttempts) {
                throw error
            }

            // Calculate delay with exponential backoff and jitter
            const exponentialDelay = minDelay * Math.pow(2, attempt - 1)
            const cappedDelay = Math.min(exponentialDelay, maxDelay)
            const jitter = Math.random() * 0.3 * cappedDelay  // 0-30% jitter
            const nextDelayMs = Math.round(cappedDelay + jitter)

            if (onRetry) {
                onRetry(error, attempt, nextDelayMs)
            }

            await delay(nextDelayMs)
        }
    }
}
