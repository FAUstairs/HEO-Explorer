import type { ReactNode } from 'react'
import AccountMenu from './AccountMenu'
import HomeLogo from './HomeLogo'

export default function ExplorerHeader({ onHome, onAdmin, onLogout, title, children }: {
    onHome?: () => void
    onAdmin?: () => void
    onLogout: () => void
    title?: string
    children: ReactNode
}) {
    return (
        <header className="topbar">
            <HomeLogo onHome={onHome} title={title} />
            <div className="header-actions">
                <div className="desktop-header-actions">{children}</div>
                <AccountMenu onAdmin={onAdmin} onLogout={onLogout} mobileActions={children} />
            </div>
        </header>
    )
}
