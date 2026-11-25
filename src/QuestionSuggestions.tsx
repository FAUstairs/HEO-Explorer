import { useEffect, useState, type FormEvent } from 'react'
import { apiUrl, authenticatedFetch } from './api'

type Suggestion = { id: string; question: string; author: string; createdAt: string; canEdit: boolean }
type Change =
    | { method: 'POST'; question: string; id?: never }
    | { method: 'PATCH'; question: string; id: string }
    | { method: 'DELETE'; id: string }
    | { method: 'DELETE'; ids: string[] }
const suggestionsPath = '/api/questions/suggestions'

export default function QuestionSuggestions({ token, canManageSuggestions }: { token: string; canManageSuggestions: boolean }) {
    const [suggestions, setSuggestions] = useState<Suggestion[]>([])
    const [loading, setLoading] = useState(true)
    const [refresh, setRefresh] = useState(0)
    const [editing, setEditing] = useState<string | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [saving, setSaving] = useState(false)
    const [listError, setListError] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)

    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            setLoading(true)
            setListError(null)
            try {
                const response = await authenticatedFetch(apiUrl(suggestionsPath), token, { signal: controller.signal })
                if (!response.ok) throw new Error('Could not load question suggestions.')
                const rows = await response.json() as Suggestion[]
                if (!controller.signal.aborted) {
                    setSuggestions(rows)
                    const visibleIds = new Set(rows.map(({ id }) => id))
                    setSelected((current) => new Set([...current].filter((id) => visibleIds.has(id))))
                }
            } catch {
                if (!controller.signal.aborted) setListError('Could not load question suggestions.')
            } finally {
                if (!controller.signal.aborted) setLoading(false)
            }
        }
        void load()
        return () => controller.abort()
    }, [token, refresh])

    async function save(change: Change): Promise<boolean> {
        setSaving(true)
        setActionError(null)
        const path = 'id' in change && change.id ? `${suggestionsPath}/${encodeURIComponent(change.id)}` : suggestionsPath
        const payload = 'question' in change ? { question: change.question } : 'ids' in change ? { ids: change.ids } : null
        try {
            const response = await authenticatedFetch(apiUrl(path), token, {
                method: change.method,
                ...(payload && {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                }),
            })
            if (!response.ok) {
                const data = await response.json().catch(() => null)
                throw new Error(data?.error ?? 'Could not save the change.')
            }
            if (change.method === 'PATCH') setEditing(null)
            if (change.method === 'DELETE') {
                const deleted = new Set('ids' in change ? change.ids : [change.id])
                setSuggestions((current) => current.filter(({ id }) => !deleted.has(id)))
                setSelected((current) => new Set([...current].filter((id) => !deleted.has(id))))
                setEditing((current) => current && deleted.has(current) ? null : current)
            }
            setRefresh((version) => version + 1)
            return true
        } catch (error) {
            setActionError(error instanceof Error ? error.message : 'Could not save the change.')
            return false
        } finally {
            setSaving(false)
        }
    }

    return (
        <section className="question-suggestions" aria-labelledby="question-suggestions-heading">
            <h2 id="question-suggestions-heading">Suggested questions</h2>
            <SuggestionForm id="new-question-suggestion" label="Suggest a question" submitLabel="Submit suggestion"
                disabled={saving} onSave={(question) => save({ method: 'POST', question })} />
            {actionError && <p className="notice error" role="alert">{actionError}</p>}
            {loading && <p role="status">Loading suggestions …</p>}
            {listError && (
                <div className="notice error">
                    <p role="alert">{listError}</p>
                    <button type="button" onClick={() => setRefresh((version) => version + 1)}>Try again</button>
                </div>
            )}
            {!loading && !listError && suggestions.length === 0 && <p>No questions have been suggested yet.</p>}
            {canManageSuggestions && suggestions.length > 0 && (
                <div className="suggestion-actions suggestion-moderation">
                    <button className="refresh-button" type="button" disabled={saving || loading} onClick={() => {
                        setSelected(selected.size === suggestions.length ? new Set() : new Set(suggestions.map(({ id }) => id)))
                    }}>{selected.size === suggestions.length ? 'Clear selection' : 'Select all'}</button>
                    <button className="refresh-button reject-registration" type="button" disabled={saving || loading || selected.size === 0} onClick={() => {
                        const ids = [...selected]
                        if (window.confirm(`Permanently delete ${ids.length} selected ${ids.length === 1 ? 'suggestion' : 'suggestions'}?`)) {
                            void save({ method: 'DELETE', ids })
                        }
                    }}>Delete selected ({selected.size})</button>
                </div>
            )}
            <ul className="question-suggestion-list">
                {suggestions.map((suggestion) => (
                    <li key={suggestion.id}>
                        {canManageSuggestions && (
                            <label className="suggestion-selection">
                                <input type="checkbox" checked={selected.has(suggestion.id)} disabled={saving || loading}
                                    onChange={(event) => {
                                        const checked = event.target.checked
                                        setSelected((current) => {
                                            const next = new Set(current)
                                            if (checked) next.add(suggestion.id)
                                            else next.delete(suggestion.id)
                                            return next
                                        })
                                    }} />
                                Select suggestion
                            </label>
                        )}
                        {editing === suggestion.id ? (
                            <SuggestionForm id={`edit-suggestion-${suggestion.id}`} label="Edit suggested question"
                                initialQuestion={suggestion.question} submitLabel="Save changes" disabled={saving}
                                onCancel={() => setEditing(null)}
                                onSave={(question) => save({ method: 'PATCH', id: suggestion.id, question })} />
                        ) : <p className="suggested-question-text">{suggestion.question}</p>}
                        <div className="suggestion-meta">
                            <span>{suggestion.author}</span>
                            <time dateTime={suggestion.createdAt}>{new Date(suggestion.createdAt).toLocaleDateString('en-GB')}</time>
                            {suggestion.canEdit && editing !== suggestion.id && (
                                <div className="suggestion-actions">
                                    <button className="refresh-button" type="button" disabled={saving} onClick={() => {
                                        setActionError(null)
                                        setEditing(suggestion.id)
                                    }}>Edit</button>
                                    <button className="refresh-button reject-registration" type="button" disabled={saving} onClick={() => {
                                        if (window.confirm('Delete this suggestion?')) void save({ method: 'DELETE', id: suggestion.id })
                                    }}>Delete</button>
                                </div>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    )
}

function SuggestionForm({ id, label, initialQuestion = '', submitLabel, disabled, onSave, onCancel }: {
    id: string
    label: string
    initialQuestion?: string
    submitLabel: string
    disabled: boolean
    onSave: (question: string) => Promise<boolean>
    onCancel?: () => void
}) {
    const [draft, setDraft] = useState(initialQuestion)

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const question = draft.trim()
        if (!disabled && question && await onSave(question)) setDraft('')
    }

    return (
        <form className="ask-question-form" onSubmit={submit}>
            <label htmlFor={id}>{label}</label>
            <textarea id={id} rows={3} maxLength={1000} required disabled={disabled} value={draft}
                onChange={(event) => setDraft(event.target.value)} />
            <div className="suggestion-actions">
                <button className="refresh-button" type="submit" disabled={disabled || !draft.trim()}>{submitLabel}</button>
                {onCancel && <button className="refresh-button" type="button" disabled={disabled} onClick={onCancel}>Cancel</button>}
            </div>
        </form>
    )
}
