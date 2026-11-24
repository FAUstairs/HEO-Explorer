const apiBaseUrl = import.meta.env.DEV
  ? import.meta.env.BASE_URL.replace(/\/$/, '')
  : (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export const apiUrl = (path: string) => `${apiBaseUrl}${path}`
