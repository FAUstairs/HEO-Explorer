import { useState, type FormEvent } from 'react'
import { apiUrl } from './api'

export default function Registration({ onBack }: { onBack: () => void }) {
    const [submitting, setSubmitting] = useState(false)
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function register(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setError(null)
        const form = new FormData(event.currentTarget)
        const password = form.get('password')
        const passwordConfirmation = form.get('passwordConfirmation')
        if (password !== passwordConfirmation) {
            setError('The passwords do not match.')
            return
        }
        setSubmitting(true)
        try {
            const response = await fetch(apiUrl('/api/auth/register'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: form.get('name'), username: form.get('username'), email: form.get('email'),
                    password, passwordConfirmation,
                }),
            })
            if (!response.ok) {
                const data = await response.json().catch(() => null)
                throw new Error(data?.error ?? 'The registration could not be submitted.')
            }
            setSubmitted(true)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The registration could not be submitted.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <main className="login-page">
            {submitted ? (
                <section className="login-card">
                    <h1>Registration submitted</h1>
                    <p role="status">You can sign in with your username or email once an administrator approves your account.</p>
                    <button type="button" onClick={onBack}>Back to sign in</button>
                </section>
            ) : (
                <form className="login-card" onSubmit={register}>
                    <div className="brand"><span className="brand-mark">H</span><span>HEO <strong>Explorer</strong></span></div>
                    <h1>Create an account</h1>
                    <label>Name<input name="name" autoComplete="name" maxLength={120} required /></label>
                    <label>Username<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                        minLength={3} maxLength={40} required /></label>
                    <label>Email<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>
                    <label>Password<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></label>
                    <label>Confirm password<input name="passwordConfirmation" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></label>
                    {error && <p className="login-error" role="alert">{error}</p>}
                    <button type="submit" disabled={submitting}>{submitting ? 'Submitting …' : 'Create account'}</button>
                    <button className="login-switch" type="button" onClick={onBack} disabled={submitting}>Back to sign in</button>
                </form>
            )}
        </main>
    )
}
