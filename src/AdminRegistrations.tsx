import { useEffect, useState } from 'react'
import { apiUrl, authenticatedFetch } from './api'

type Status = 'pending' | 'active' | 'rejected'
type Decision = 'approve' | 'reject' | 'delete'
type Account = {
    username: string
    name: string
    email: string | null
    role: string
    status: Status
    createdAt: string
    rejectedAt: string | null
    canDelete?: boolean
}
type LegacyRegistration = Pick<Account, 'name' | 'createdAt'> & { email: string; status?: undefined }

const accountViews = {
    pending: { label: 'Pending registrations', empty: 'No registrations are awaiting approval.' },
    active: { label: 'Active accounts', empty: 'No active accounts.' },
    rejected: { label: 'Rejected accounts', empty: 'No accounts have been rejected.' },
} satisfies Record<Status, { label: string; empty: string }>

export default function AdminRegistrations({ token }: { token: string }) {
    const [accounts, setAccounts] = useState<Account[]>([])
    const [view, setView] = useState<Status>('pending')
    const [loading, setLoading] = useState(true)
    const [reload, setReload] = useState(0)
    const [saving, setSaving] = useState<{ username: string; decision: Decision } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [feedback, setFeedback] = useState('')
    const [legacyResponse, setLegacyResponse] = useState(false)

    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            try {
                const response = await authenticatedFetch(apiUrl('/api/admin/registrations?view=all'), token, { signal: controller.signal })
                if (!response.ok) throw new Error(response.status === 403 ? 'Administrator access is required.' : 'Could not load accounts.')
                const rows = await response.json() as (Account | LegacyRegistration)[]
                if (!Array.isArray(rows)) throw new Error('The HEO API returned an unexpected account list.')
                if (controller.signal.aborted) return
                setLegacyResponse(rows.some((row) => row.status === undefined))
                setAccounts(rows.map((row): Account => row.status === undefined ? {
                    ...row, username: row.email, role: 'user', status: 'pending', rejectedAt: null,
                } : row))
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load accounts.')
            } finally {
                if (!controller.signal.aborted) setLoading(false)
            }
        }
        void load()
        return () => controller.abort()
    }, [token, reload])

    async function decide(account: Account, decision: Decision) {
        setSaving({ username: account.username, decision })
        setError(null)
        setFeedback('')
        try {
            const deleting = decision === 'delete'
            const path = deleting ? '/api/admin/accounts' : `/api/admin/registrations/${decision}`
            const response = await authenticatedFetch(apiUrl(path), token, {
                method: deleting ? 'DELETE' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(deleting ? { username: account.username } : { email: account.email }),
            })
            if (!response.ok) {
                if (response.status === 409 || response.status === 404) {
                    setLoading(true)
                    setReload((value) => value + 1)
                }
                const data = await response.json().catch(() => null)
                throw new Error(data?.error ?? 'The account could not be updated.')
            }
            setFeedback(`${account.name}'s account was ${deleting ? 'deleted' : decision === 'approve' ? 'approved' : 'rejected'}.`)
            setLoading(true)
            setReload((value) => value + 1)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The account could not be updated.')
        } finally {
            setSaving(null)
        }
    }

    const visibleAccounts = accounts.filter((account) => account.status === view)
    const viewAvailable = !legacyResponse || view === 'pending'

    return (
        <section className="property-page">
            <div className="instances-heading">
                <h1>Accounts</h1>
                <button className="refresh-button" type="button" disabled={loading || saving !== null} onClick={() => {
                    setLoading(true)
                    setError(null)
                    setFeedback('')
                    setReload((value) => value + 1)
                }}>Refresh</button>
            </div>
            <div className="filter-group admin-account-views" role="group" aria-label="Account status">
                {(Object.keys(accountViews) as Status[]).map((status) => (
                    <button key={status} type="button" className={view === status ? 'active' : undefined}
                        aria-pressed={view === status} onClick={() => setView(status)}>
                        {accountViews[status].label}
                    </button>
                ))}
            </div>
            {loading && <p role="status">Loading accounts …</p>}
            {error && <p className="notice error" role="alert">{error}</p>}
            {feedback && <p role="status">{feedback}</p>}
            {!loading && legacyResponse && <p role="status">The HEO API is running an older version. Restart it with the current code to enable account rejection and the other account lists.</p>}
            {!loading && !error && viewAvailable && visibleAccounts.length === 0 && <p>{accountViews[view].empty}</p>}
            {!loading && viewAvailable && visibleAccounts.length > 0 && (
                <div className="admin-registrations-table">
                    <table className="question-counts" aria-label={accountViews[view].label}>
                        <thead><tr>
                            <th scope="col">Name</th><th scope="col">Username</th><th scope="col">Email</th>
                            <th scope="col">Role</th><th scope="col">Registered</th>
                            {view === 'rejected' && <th scope="col">Rejected on</th>}
                            <th scope="col">Actions</th>
                        </tr></thead>
                        <tbody>{visibleAccounts.map((account) => (
                            <tr key={account.username}>
                                <td>{account.name}</td>
                                <td>{account.username.toLowerCase() === account.email?.toLowerCase()
                                    ? <span title="No separate username available">—</span>
                                    : account.username}</td>
                                <td>{account.email ?? '—'}</td>
                                <td>{account.role === 'admin' ? 'Admin' : 'User'}</td>
                                <td>{new Date(account.createdAt).toLocaleDateString()}</td>
                                {view === 'pending' && (
                                    <td><div className="admin-registration-actions">
                                        <button className="refresh-button" type="button" disabled={saving !== null || !account.email}
                                            onClick={() => void decide(account, 'approve')}>
                                            {saving?.username === account.username && saving.decision === 'approve' ? 'Approving …' : 'Approve'}
                                        </button>
                                        <button className="refresh-button reject-registration" type="button" disabled={legacyResponse || saving !== null || !account.email}
                                            onClick={() => void decide(account, 'reject')}>
                                            {saving?.username === account.username && saving.decision === 'reject' ? 'Rejecting …' : 'Reject'}
                                        </button>
                                    </div></td>
                                )}
                                {view === 'rejected' && <td>{account.rejectedAt ? new Date(account.rejectedAt).toLocaleDateString() : '—'}</td>}
                                {view !== 'pending' && (
                                    <td>
                                        {account.canDelete === undefined ? '—' : (
                                            <div className="admin-registration-actions">
                                                <button className="refresh-button reject-registration" type="button"
                                                    disabled={saving !== null || !account.canDelete}
                                                    title={account.canDelete ? undefined : 'This administrator account is protected.'}
                                                    onClick={() => {
                                                        if (window.confirm(`Permanently delete the account ${account.username}?`)) void decide(account, 'delete')
                                                    }}>
                                                    {saving?.username === account.username && saving.decision === 'delete' ? 'Deleting …' : 'Delete'}
                                                </button>
                                            </div>
                                        )}
                                    </td>
                                )}
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
            )}
        </section>
    )
}
