import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { DirectorySection } from '../src/components/NewSession/DirectorySection'
import { I18nProvider } from '../src/lib/i18n-context'

const windowsPath = 'C:\\Users\\Example\\Downloads\\Agent\\Hapi\\worktrees\\directory-scroll-project'
const posixPath = '/home/example/projects/hapi/worktrees/mobile-directory-scroll-project'

function Fixture() {
    const [directory, setDirectory] = useState(new URLSearchParams(location.search).get('path') ?? windowsPath)
    const [disabled, setDisabled] = useState(false)
    const [revision, setRevision] = useState(0)
    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
            <header className="border-b border-[var(--app-border)] p-4">HAPI · New Session · Directory fixture</header>
            <main className="app-scroll-y min-h-0 flex-1">
                <DirectorySection
                    directory={directory}
                    suggestions={[]}
                    selectedIndex={0}
                    isDisabled={disabled}
                    recentPaths={[windowsPath, posixPath, '/tmp']}
                    onDirectoryChange={setDirectory}
                    onDirectoryFocus={() => {}}
                    onDirectoryBlur={() => {}}
                    onDirectoryKeyDown={() => {}}
                    onSuggestionSelect={() => {}}
                    onPathClick={setDirectory}
                    onChooseFolder={() => setDirectory(posixPath)}
                />
                <div className="flex flex-wrap gap-3 p-3">
                    <button onClick={() => setRevision(revision + 1)}>Unrelated update {revision}</button>
                    <button onClick={() => setDisabled(!disabled)}>Toggle disabled</button>
                    <button onClick={() => setDirectory('')}>Clear</button>
                </div>
                <output className="block break-all p-3" data-testid="directory-value">{directory}</output>
                <div className="h-[1200px] p-3">Vertical scrolling remains available.</div>
            </main>
        </div>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode><I18nProvider><Fixture /></I18nProvider></StrictMode>
)
