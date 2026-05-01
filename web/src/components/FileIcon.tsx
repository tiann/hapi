import { useMemo } from 'react'

type FileIconMeta = {
    label: string
    color: string
    text?: string
    glyph?: string
}

type FolderIconMeta = {
    label: string
    color: string
}

const EXTENSION_ICONS: Record<string, FileIconMeta> = {
    ts: { label: 'TypeScript file', color: '#3178c6', text: 'TS' },
    tsx: { label: 'TypeScript React file', color: '#3178c6', text: 'TSX' },
    js: { label: 'JavaScript file', color: '#f7df1e', text: 'JS' },
    jsx: { label: 'JavaScript React file', color: '#f7df1e', text: 'JSX' },
    mjs: { label: 'JavaScript module file', color: '#f7df1e', text: 'JS' },
    cjs: { label: 'JavaScript commonjs file', color: '#f7df1e', text: 'JS' },
    json: { label: 'JSON file', color: '#f59e0b', glyph: '{}' },
    md: { label: 'Markdown file', color: '#64748b', text: 'MD' },
    mdx: { label: 'MDX file', color: '#64748b', text: 'MDX' },
    css: { label: 'CSS file', color: '#2563eb', text: 'CSS' },
    scss: { label: 'SCSS file', color: '#db2777', text: 'SCSS' },
    sass: { label: 'Sass file', color: '#db2777', text: 'SASS' },
    less: { label: 'Less file', color: '#2563eb', text: 'LESS' },
    html: { label: 'HTML file', color: '#f97316', text: 'HTML' },
    htm: { label: 'HTML file', color: '#f97316', text: 'HTML' },
    xml: { label: 'XML file', color: '#f97316', glyph: '<>' },
    yml: { label: 'YAML file', color: '#ef4444', text: 'YML' },
    yaml: { label: 'YAML file', color: '#ef4444', text: 'YML' },
    sh: { label: 'Shell script', color: '#10b981', glyph: '$' },
    bash: { label: 'Bash script', color: '#10b981', glyph: '$' },
    zsh: { label: 'Zsh script', color: '#10b981', glyph: '$' },
    py: { label: 'Python file', color: '#3776ab', text: 'PY' },
    go: { label: 'Go file', color: '#0ea5e9', text: 'GO' },
    rs: { label: 'Rust file', color: '#f97316', text: 'RS' },
    java: { label: 'Java file', color: '#ef4444', text: 'JAVA' },
    kt: { label: 'Kotlin file', color: '#a855f7', text: 'KT' },
    php: { label: 'PHP file', color: '#777bb4', text: 'PHP' },
    rb: { label: 'Ruby file', color: '#cc342d', text: 'RB' },
    swift: { label: 'Swift file', color: '#f97316', text: 'SW' },
    c: { label: 'C file', color: '#64748b', text: 'C' },
    h: { label: 'Header file', color: '#64748b', text: 'H' },
    cpp: { label: 'C++ file', color: '#2563eb', text: 'C++' },
    cc: { label: 'C++ file', color: '#2563eb', text: 'C++' },
    cs: { label: 'C# file', color: '#7c3aed', text: 'C#' },
    sql: { label: 'SQL file', color: '#38bdf8', text: 'SQL' },
    graphql: { label: 'GraphQL file', color: '#e535ab', text: 'GQL' },
    gql: { label: 'GraphQL file', color: '#e535ab', text: 'GQL' },
    vue: { label: 'Vue file', color: '#42b883', text: 'VUE' },
    svelte: { label: 'Svelte file', color: '#ff3e00', text: 'SV' },
    astro: { label: 'Astro file', color: '#f97316', text: 'AST' },
    lock: { label: 'Lock file', color: '#94a3b8', glyph: '🔒' },
    log: { label: 'Log file', color: '#94a3b8', text: 'LOG' },
    toml: { label: 'TOML file', color: '#f97316', text: 'TOML' },
    ini: { label: 'INI file', color: '#94a3b8', glyph: '⚙' },
    conf: { label: 'Config file', color: '#94a3b8', glyph: '⚙' },
    env: { label: 'Environment file', color: '#22c55e', glyph: '⚙' },
    png: { label: 'Image file', color: '#a855f7', glyph: '◒' },
    jpg: { label: 'Image file', color: '#a855f7', glyph: '◒' },
    jpeg: { label: 'Image file', color: '#a855f7', glyph: '◒' },
    gif: { label: 'Image file', color: '#a855f7', glyph: '◒' },
    svg: { label: 'SVG file', color: '#f59e0b', text: 'SVG' },
    pdf: { label: 'PDF file', color: '#ef4444', text: 'PDF' },
    zip: { label: 'Archive file', color: '#94a3b8', glyph: '▣' },
}

const FILE_NAME_ICONS: Record<string, FileIconMeta> = {
    'package.json': { label: 'Package manifest', color: '#22c55e', glyph: '⬢' },
    'bun.lock': { label: 'Bun lock file', color: '#f5deb3', glyph: 'B' },
    'bun.lockb': { label: 'Bun lock file', color: '#f5deb3', glyph: 'B' },
    'package-lock.json': { label: 'NPM lock file', color: '#cb3837', glyph: 'N' },
    'pnpm-lock.yaml': { label: 'PNPM lock file', color: '#f59e0b', glyph: 'P' },
    'yarn.lock': { label: 'Yarn lock file', color: '#2c8ebb', glyph: 'Y' },
    'tsconfig.json': { label: 'TypeScript config', color: '#3178c6', text: 'TS' },
    'vite.config.ts': { label: 'Vite config', color: '#a855f7', glyph: 'V' },
    'vite.config.js': { label: 'Vite config', color: '#a855f7', glyph: 'V' },
    'next.config.js': { label: 'Next.js config', color: '#111827', glyph: 'N' },
    'next.config.ts': { label: 'Next.js config', color: '#111827', glyph: 'N' },
    'dockerfile': { label: 'Dockerfile', color: '#2496ed', glyph: '◆' },
    'docker-compose.yml': { label: 'Docker Compose file', color: '#2496ed', glyph: '◆' },
    'docker-compose.yaml': { label: 'Docker Compose file', color: '#2496ed', glyph: '◆' },
    'readme.md': { label: 'Readme file', color: '#64748b', text: 'README' },
    'license': { label: 'License file', color: '#f59e0b', glyph: '§' },
    '.gitignore': { label: 'Git ignore file', color: '#ef4444', glyph: 'git' },
    '.env': { label: 'Environment file', color: '#22c55e', glyph: '⚙' },
    '.env.local': { label: 'Environment file', color: '#22c55e', glyph: '⚙' },
}

const FOLDER_ICONS: Record<string, FolderIconMeta> = {
    src: { label: 'Source folder', color: '#60a5fa' },
    source: { label: 'Source folder', color: '#60a5fa' },
    components: { label: 'Components folder', color: '#818cf8' },
    app: { label: 'App folder', color: '#818cf8' },
    pages: { label: 'Pages folder', color: '#818cf8' },
    routes: { label: 'Routes folder', color: '#818cf8' },
    tests: { label: 'Tests folder', color: '#22c55e' },
    test: { label: 'Tests folder', color: '#22c55e' },
    __tests__: { label: 'Tests folder', color: '#22c55e' },
    docs: { label: 'Docs folder', color: '#64748b' },
    doc: { label: 'Docs folder', color: '#64748b' },
    public: { label: 'Public assets folder', color: '#f59e0b' },
    assets: { label: 'Assets folder', color: '#f59e0b' },
    images: { label: 'Images folder', color: '#a855f7' },
    node_modules: { label: 'Node modules folder', color: '#22c55e' },
    '.git': { label: 'Git folder', color: '#ef4444' },
    '.github': { label: 'GitHub folder', color: '#64748b' },
    scripts: { label: 'Scripts folder', color: '#10b981' },
    config: { label: 'Config folder', color: '#94a3b8' },
}

function getFileExtension(fileName: string): string {
    const trimmed = fileName.trim()
    if (trimmed.startsWith('.') && trimmed.indexOf('.', 1) === -1) {
        return trimmed.slice(1).toLowerCase()
    }
    const parts = trimmed.split('.')
    if (parts.length <= 1) return ''
    return parts[parts.length - 1]?.toLowerCase() ?? ''
}

function getFileIconMeta(fileName: string): FileIconMeta {
    const baseName = fileName.split('/').filter(Boolean).pop() ?? fileName
    const lowerName = baseName.toLowerCase()
    const ext = getFileExtension(baseName)
    return FILE_NAME_ICONS[lowerName]
        ?? EXTENSION_ICONS[ext]
        ?? { label: 'File', color: 'var(--app-hint)' }
}

function getFolderIconMeta(folderName: string): FolderIconMeta {
    const baseName = folderName.split('/').filter(Boolean).pop() ?? folderName
    return FOLDER_ICONS[baseName.toLowerCase()]
        ?? { label: 'Folder', color: 'var(--app-link)' }
}

export function FileIcon(props: { fileName: string; size?: number }) {
    const size = props.size ?? 20
    const meta = useMemo(() => getFileIconMeta(props.fileName), [props.fileName])
    const text = meta.text ?? meta.glyph ?? ''

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: meta.color }}
            aria-label={meta.label}
            role="img"
        >
            <title>{meta.label}</title>
            {text ? (
                <>
                    <rect x="3.5" y="4" width="17" height="16" rx="3" fill="currentColor" stroke="none" opacity="0.18" />
                    <rect x="3.5" y="4" width="17" height="16" rx="3" />
                    <text
                        x="12"
                        y="14.2"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="currentColor"
                        stroke="none"
                        fontSize={text.length > 3 ? 4.2 : text.length > 2 ? 5.2 : 6.5}
                        fontWeight="700"
                        fontFamily="ui-sans-serif, system-ui, sans-serif"
                    >
                        {text}
                    </text>
                </>
            ) : (
                <>
                    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                </>
            )}
        </svg>
    )
}

export function FolderIcon(props: { folderName: string; open?: boolean; size?: number }) {
    const size = props.size ?? 20
    const meta = useMemo(() => getFolderIconMeta(props.folderName), [props.folderName])

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: meta.color }}
            aria-label={meta.label}
            role="img"
        >
            <title>{meta.label}</title>
            {props.open ? (
                <>
                    <path d="M3 8.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3v-3Z" fill="currentColor" opacity="0.18" />
                    <path d="M3 8.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3v-3Z" />
                    <path d="M3 11h18l-2 7H5l-2-7Z" fill="currentColor" opacity="0.12" />
                    <path d="M3 11h18l-2 7H5l-2-7Z" />
                </>
            ) : (
                <>
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" opacity="0.14" />
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </>
            )}
        </svg>
    )
}
