export const classNamespaces = {
    HEO: 'https://mathhub.info/heo#',
    ULO: 'http://mathhub.info/ulo#',
} as const

export type ClassNamespace = keyof typeof classNamespaces
