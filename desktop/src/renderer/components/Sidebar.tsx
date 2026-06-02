import type { Dictionary } from '../i18n'
import logoUrl from '../../../assets/icon.png'

export type Page = 'home' | 'settings'

type Props = {
    activePage: Page
    dict: Dictionary
    openWebEnabled: boolean
    onNavigate: (page: Page) => void
    onOpenWeb: () => void
}

export function Sidebar({ activePage, dict, openWebEnabled, onNavigate, onOpenWeb }: Props) {
    return (
        <aside className="sidebar">
            <div className="brand">
                <img className="brand-logo" src={logoUrl} alt="" />
                <div>
                    <div className="brand-main">HAPI</div>
                    <div className="brand-sub">Desktop</div>
                </div>
            </div>
            <nav className="nav-list">
                <button className={activePage === 'home' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => onNavigate('home')}>{dict.home}</button>
                <button className={activePage === 'settings' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => onNavigate('settings')}>{dict.settings}</button>
                <button className="nav-item" type="button" disabled={!openWebEnabled} onClick={onOpenWeb}>{dict.openWeb}</button>
            </nav>
        </aside>
    )
}
