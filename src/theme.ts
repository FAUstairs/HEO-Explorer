export type Theme = 'light' | 'dark'

const themeKey = 'heo-explorer-theme'

export function initialiseTheme() {
    document.documentElement.dataset.theme = localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light'
}

export function currentTheme(): Theme {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme: Theme) {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(themeKey, theme)
}
