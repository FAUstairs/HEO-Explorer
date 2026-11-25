export default function HomeLogo({ onHome, title = 'Explorer' }: { onHome?: () => void; title?: string }) {
    return (
        <a className="brand brand-link" href={import.meta.env.BASE_URL} aria-label="HEO Explorer home"
            onClick={(event) => {
                if (!onHome || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                onHome()
            }}>
            <span className="brand-mark" aria-hidden="true">H</span>
            <span>HEO <strong>{title}</strong></span>
        </a>
    )
}
