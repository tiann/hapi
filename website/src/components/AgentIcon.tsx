// Agent brand logos, mirroring web/src/components/AgentFlavorIcon.tsx so the site and
// the app show the same marks. Deep imports on purpose: the package root re-exports
// ./features, which pulls in peer deps (@lobehub/ui, antd) the site doesn't install.
import AntigravityColor from "@lobehub/icons/es/Antigravity/components/Color";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import CodexMono from "@lobehub/icons/es/Codex/components/Mono";
import CursorMono from "@lobehub/icons/es/Cursor/components/Mono";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import type { IconType } from "@lobehub/icons/es/types";
import type { AgentFlavor } from "../const";

function CopilotLogo({ size }: { size: string }) {
    // GitHub mark, as in the web app, until @lobehub/icons ships a Copilot asset.
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
        </svg>
    );
}

function PiLogo({ size }: { size: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 800 800" fill="currentColor">
            <path
                fillRule="evenodd"
                d="M165.29 165.29h352.07V400H400v117.36H282.65v117.36H165.29zM282.65 282.65V400H400V282.65z"
            />
            <path d="M517.36 400h117.36v234.72H517.36z" />
        </svg>
    );
}

const LOGOS: Record<Exclude<AgentFlavor, "copilot" | "pi">, IconType> = {
    agy: AntigravityColor,
    claude: ClaudeColor,
    codex: CodexMono,
    cursor: CursorMono,
    dsh: DeepSeekColor,
    grok: GrokMono,
    kimi: KimiMono,
    opencode: OpenCodeMono,
};

export function AgentIcon({ flavor }: { flavor: AgentFlavor }) {
    const size = "100%";
    return (
        <span className="agent-icon" aria-hidden>
            {flavor === "copilot" ? (
                <CopilotLogo size={size} />
            ) : flavor === "pi" ? (
                <PiLogo size={size} />
            ) : (
                (() => {
                    const Logo = LOGOS[flavor];
                    return <Logo size={size} color={flavor === "codex" ? "#6179F5" : undefined} />;
                })()
            )}
        </span>
    );
}
