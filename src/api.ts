const apiBaseUrl = import.meta.env.DEV
  ? import.meta.env.BASE_URL.replace(/\/$/, '')
  : (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export const apiUrl = (path: string) => `${apiBaseUrl}${path}`

const rejectedSessions = new EventTarget()

export function watchRejectedSession(onRejected: (token: string) => void): () => void {
  const listener = (event: Event) => onRejected((event as CustomEvent<string>).detail)
  rejectedSessions.addEventListener('rejected', listener)
  return () => rejectedSessions.removeEventListener('rejected', listener)
}

export function sessionExpiry(token: string): number | undefined {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const { exp } = JSON.parse(atob(payload)) as { exp?: number }
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

export async function authenticatedFetch(url: string, token: string | null, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(url, { ...options, headers })
  if (token && response.status === 401) {
    // Query requests can also return a 401 from the upstream ontology service.
    const failure = await response.clone().json().catch(() => null)
    if (failure?.error === 'Invalid or expired session.' || failure?.error === 'Authentication required.') {
      rejectedSessions.dispatchEvent(new CustomEvent('rejected', { detail: token }))
    }
  }
  return response
}
