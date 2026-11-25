import { useEffect, useRef, useState, type ReactNode } from 'react'
import { KeyRound, LogOut, Menu, Moon, Shield, Snowflake, Sun } from 'lucide-react'
import { applyTheme, currentTheme } from './theme'
import { isSnowEnabled, setSnowEnabled } from './Snowfall'

export default function AccountMenu({ onAdmin, onLogout, onChangePassword, mobileActions }: { onAdmin?: () => void; onLogout: () => void; onChangePassword: () => void; mobileActions: ReactNode }) {
    const [snow, setSnow] = useState(isSnowEnabled)
    const [theme, setTheme] = useState(currentTheme)
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    const ThemeIcon = nextTheme === 'dark' ? Moon : Sun
    const details = useRef<HTMLDetailsElement>(null)
    const trigger = useRef<HTMLElement>(null)

    useEffect(() => {
        function closeOutside(event: PointerEvent) {
            const menu = details.current
            if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false
        }
        document.addEventListener('pointerdown', closeOutside)
        return () => document.removeEventListener('pointerdown', closeOutside)
    }, [])

    function select(action: () => void) {
        if (details.current) details.current.open = false
        action()
    }

    return (
        <details className="account-menu" ref={details} onKeyDown={(event) => {
            if (event.key !== 'Escape' || !details.current?.open) return
            event.preventDefault()
            details.current.open = false
            trigger.current?.focus()
        }}>
            <summary ref={trigger} className="refresh-button"><Menu size={16} aria-hidden="true" /> Menu</summary>
            <div className="account-menu-options">
                <div className="mobile-header-actions" onClick={(event) => {
                    if (!(event.target instanceof Element) || !event.target.closest('button, a')) return
                    if (details.current) details.current.open = false
                    trigger.current?.focus()
                }}>{mobileActions}</div>
                {onAdmin && <button type="button" onClick={() => select(onAdmin)}><Shield size={16} aria-hidden="true" /> Admin</button>}
                <button type="button" onClick={() => {
                    applyTheme(nextTheme)
                    setTheme(nextTheme)
                }}><ThemeIcon size={16} aria-hidden="true" /> {nextTheme === 'dark' ? 'Dark mode' : 'Light mode'}</button>
                <button type="button" aria-pressed={snow} onClick={() => {
                    setSnowEnabled(!snow)
                    setSnow(!snow)
                }}><Snowflake size={16} aria-hidden="true" /> Snow <span className="account-menu-state" aria-hidden="true">{snow ? 'On' : 'Off'}</span></button>
                <button type="button" onClick={() => select(onChangePassword)}><KeyRound size={16} aria-hidden="true" /> Change password</button>
                <button type="button" onClick={() => select(onLogout)}><LogOut size={16} aria-hidden="true" /> Log out</button>
            </div>
        </details>
    )
}
