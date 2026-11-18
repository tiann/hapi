export const SITE_URL = "https://hapi.run";
export const GITHUB_URL = "https://github.com/tiann/hapi";
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const NPM_URL = "https://www.npmjs.com/package/@twsxtd/hapi";
export const APP_STORE_URL = "https://apps.apple.com/app/id6805699104";
export const GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=run.hapi.companion";

export const DOCS = {
    home: "/docs/",
    quickStart: "/docs/guide/quick-start",
    agents: "/docs/guide/agents",
    howItWorks: "/docs/guide/how-it-works",
    nativeApps: "/docs/guide/native-apps",
    whyHapi: "/docs/guide/why-hapi",
    faq: "/docs/guide/faq",
    privacy: "/docs/privacy",
};

export type AgentFlavor = "claude" | "codex" | "cursor" | "grok" | "opencode" | "kimi" | "copilot" | "agy" | "pi" | "dsh";

// Display names and flavor ids (shared/src/modes.ts) of the agents HAPI supports.
export const AGENTS: { name: string; flavor: AgentFlavor }[] = [
    { name: "Claude Code", flavor: "claude" },
    { name: "Codex", flavor: "codex" },
    { name: "Cursor Agent", flavor: "cursor" },
    { name: "Grok Build", flavor: "grok" },
    { name: "OpenCode", flavor: "opencode" },
    { name: "Kimi", flavor: "kimi" },
    { name: "GitHub Copilot", flavor: "copilot" },
    { name: "Antigravity", flavor: "agy" },
    { name: "Pi", flavor: "pi" },
    { name: "DeepSeek Harness", flavor: "dsh" },
];

export const SUPPORTED_AGENTS = AGENTS.map((agent) => agent.name);
