import type { ReactNode } from 'react'

/**
 * BrandedFrame wraps the app content with HAPImatic branding:
 * - Mint green header bar with "HAPImatic" text in white
 * - Mint green border on left, right, and bottom edges
 * - Handles iOS safe-area-inset-top for the header
 */
export function BrandedFrame({ children }: { children: ReactNode }) {
    return (
        <div className="h-full flex flex-col bg-[var(--color-primary)]">
            {/* Branded header - handles safe area for iOS status bar */}
            <div className="pt-[env(safe-area-inset-top)]">
                <div className="px-3 py-2 text-center border-b-2 border-[var(--color-accent)]/40">
                    <svg
                        viewBox="0 0 200 40"
                        className="h-7 mx-auto"
                        aria-label="HAPImatic"
                    >
                        <text
                            x="100"
                            y="30"
                            textAnchor="middle"
                            fontFamily="'Varela Round', system-ui, sans-serif"
                            fontWeight="normal"
                            fontSize="28"
                            letterSpacing="2"
                            fill="white"
                            stroke="var(--color-accent)"
                            strokeWidth="3"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            paintOrder="stroke fill"
                        >
                            HAPImatic
                        </text>
                    </svg>
                </div>
            </div>

            {/* Content wrapper - thin border on sides, slightly more at bottom for rounded corners */}
            <div className="flex-1 min-h-0 flex flex-col px-1 pt-1 pb-2">
                {/* Content area with rounded corners to match iPhone screen shape */}
                <div className="flex-1 min-h-0 flex flex-col bg-[var(--app-bg)] overflow-hidden rounded-2xl">
                    {children}
                </div>
            </div>
            {/* Bottom safe area - mint green shows through */}
            <div className="pb-[env(safe-area-inset-bottom)]" />
        </div>
    )
}
