import { useEffect, useState } from "react";

const GITHUB_REPO = "tiann/hapi";
const CACHE_KEY = "hapi-latest-version";
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

interface CachedVersion {
    version: string;
    timestamp: number;
}

/**
 * Latest GitHub release tag. Always `null` during prerender and the hydration
 * render (so server and client markup match); filled in after mount.
 */
export function useLatestVersion(): string | null {
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const parsed: CachedVersion = JSON.parse(cached);
                if (Date.now() - parsed.timestamp < CACHE_TTL) {
                    setVersion(parsed.version);
                    return;
                }
            }
        } catch {
            // Ignore cache errors
        }

        fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            headers: { Accept: "application/vnd.github.v3+json" },
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { tag_name?: string } | null) => {
                const tag = data?.tag_name;
                if (!tag || cancelled) return;
                setVersion(tag);
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: tag, timestamp: Date.now() }));
                } catch {
                    // Ignore storage errors
                }
            })
            .catch(() => {
                // Keep the placeholder on error
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return version;
}
