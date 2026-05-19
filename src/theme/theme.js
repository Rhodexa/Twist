// Runtime theme switching. CSS vars in theme.css are the defaults;
// calling applyTheme() overrides them dynamically.

const themes = {
    dark: {
        '--bg-base':        '#1e1e1e',
        '--bg-panel':       '#252526',
        '--bg-elevated':    '#2d2d2d',
        '--bg-hover':       '#2a2d2e',
        '--bg-selected':    '#094771',
        '--border':         '#3e3e3e',
        '--border-focus':   '#007fd4',
        '--text-primary':   '#d4d4d4',
        '--text-secondary': '#858585',
        '--text-disabled':  '#5a5a5a',
        '--accent':         '#569cd6',
        '--accent-hover':   '#4e8fcc',
        '--color-error':    '#f44747',
        '--color-warning':  '#d7ba7d',
        '--color-ok':       '#4ec9b0',
    },

    // Add more themes here — same key set, different values.
}

let activeTheme = 'dark'

function applyTheme(name) {
    const theme = themes[name]
    if (!theme) { console.warn(`Theme "${name}" not found`); return }
    const root = document.documentElement
    for (const [key, value] of Object.entries(theme)) {
        root.style.setProperty(key, value)
    }
    activeTheme = name
}

function getActiveTheme() { return activeTheme }

export { themes, applyTheme, getActiveTheme }
