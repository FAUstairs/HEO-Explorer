import { useState, type FormEvent } from 'react'
import { apiUrl, authenticatedFetch } from './api'

export default function ChangePassword({ token, onChanged }: { token: string; onChanged: () => void }) {
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const newPassword = form.get('newPassword')
        const passwordConfirmation = form.get('passwordConfirmation')
        if (newPassword !== passwordConfirmation) {
            setError('The new passwords do not match.')
            return
        }
        setError(null)
        setSaving(true)
        try {
            const response = await authenticatedFetch(apiUrl('/api/auth/change-password'), token, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword, passwordConfirmation }),
            }).catch(() => {
                throw new Error('Could not reach the HEO API. Check the connection and try again.')
            })
            if (response.status === 204) {
                onChanged()
                return
            }

            const failure = await response.json().catch(() => null)
            if (typeof failure?.error === 'string' && failure.error) {
                throw new Error(failure.error)
            }
            if (response.status === 404 || response.status === 405) {
                throw new Error(`The password change endpoint is unavailable (HTTP ${response.status}). Check that the updated HEO API is running and the proxy forwards this route.`)
            }
            if (response.status === 502 || response.status === 503 || response.status === 504) {
                throw new Error(`The proxy could not reach the HEO API (HTTP ${response.status}). Check that the backend service is running.`)
            }
            throw new Error(`Unexpected response from the HEO API (HTTP ${response.status}). Check the backend logs and proxy configuration.`)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The password could not be changed.')
        } finally {
            setSaving(false)
        }
    }

    return (
        <section className="property-page">
            <form className="login-card" onSubmit={submit}>
                <h1>Change password</h1>
                <label>Current password<input type="password" name="currentPassword" autoComplete="current-password" required /></label>
                <label>New password<input type="password" name="newPassword" autoComplete="new-password" minLength={8} maxLength={72} required /></label>
                <label>Confirm new password<input type="password" name="passwordConfirmation" autoComplete="new-password" minLength={8} maxLength={72} required /></label>
                {error && <p className="login-error" role="alert">{error}</p>}
                <button type="submit" disabled={saving}>{saving ? 'Saving …' : 'Change password'}</button>
            </form>
        </section>
    )
}
