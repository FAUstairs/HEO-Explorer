import type { CSSProperties } from 'react'

const flakes = Array.from({ length: 48 }, (_, index) => ({
    '--snow-left': `${(index * 37 % 1000) / 10}%`,
    '--snow-rest-top': `${(index * 43) % 100}%`,
    '--snow-size': `${2 + index % 5}px`,
    '--snow-duration': `${8 + (index * 7) % 12}s`,
    '--snow-delay': `${-(index * 13 % 24)}s`,
    '--snow-drift': `${(index * 11 % 75) - 37}px`,
}) as CSSProperties)

export function isSnowEnabled() {
    return document.documentElement.dataset.snow === 'on'
}

export function setSnowEnabled(enabled: boolean) {
    document.documentElement.dataset.snow = enabled ? 'on' : 'off'
}

export default function Snowfall() {
    return (
        <div className="snowfall" aria-hidden="true">
            {flakes.map((style, index) => <span key={index} style={style} />)}
        </div>
    )
}
