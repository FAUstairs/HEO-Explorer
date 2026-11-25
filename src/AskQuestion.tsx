import { useState, type FormEvent } from 'react'
import { apiUrl, authenticatedFetch } from './api'
import type { QuestionAnswer } from './questionAnswer'

type SelectAnswer = Extract<QuestionAnswer['result'], { columns: string[] }>
const freeTextQuestionsAvailable = false

export default function AskQuestion({ token }: { token: string }) {
    const [question, setQuestion] = useState('')
    const [answer, setAnswer] = useState<QuestionAnswer | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!freeTextQuestionsAvailable || !question.trim() || loading) return
        setLoading(true)
        setAnswer(null)
        setError(null)
        try {
            const response = await authenticatedFetch(apiUrl('/api/questions'), token, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: question.trim() }),
            })
            if (!response.ok) {
                const failure = await response.json().catch(() => null)
                throw new Error(failure?.error || `The HEO API returned HTTP ${response.status}.`)
            }
            setAnswer(await response.json() as QuestionAnswer)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The question could not be answered.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <section className="ask-question" aria-labelledby="ask-question-heading">
            <h2 id="ask-question-heading">Ask a question</h2>
            <form onSubmit={submit} className="ask-question-form">
                <label htmlFor="ontology-question">Your question about HEO or ULO</label>
                <textarea id="ontology-question" value={question} onChange={(event) => setQuestion(event.target.value)}
                    placeholder="Which subjects have the most study programmes?" rows={3} maxLength={1500} required
                    disabled={!freeTextQuestionsAvailable} aria-describedby="ontology-question-hint" />
                <p id="ontology-question-hint" className={freeTextQuestionsAvailable ? 'ask-question-hint' : 'ask-question-hint unavailable'}>{freeTextQuestionsAvailable
                    ? 'Your question and the ontology schema are sent to OpenAI to generate a SPARQL query.'
                    : 'Free-text questions are temporarily unavailable.'}</p>
                <button className="refresh-button" type="submit" disabled={!freeTextQuestionsAvailable || !question.trim() || loading}>Ask question</button>
            </form>
            {loading && <p role="status">Loading the ontology schema, generating and running the query …</p>}
            {error && <p role="alert" className="notice error">{error}</p>}
            {answer && (
                <section className="ask-question-answer" aria-labelledby="question-answer-heading">
                    <h3 id="question-answer-heading">Query result</h3>
                    {'boolean' in answer.result
                        ? <p className="ask-question-value" role="status">{answer.result.boolean ? 'Yes' : 'No'}</p>
                        : <QueryResult result={answer.result} />}
                </section>
            )}
            {answer && (
                <details className="ask-question-query">
                    <summary>Show executed SPARQL query</summary>
                    <pre className="json-viewer"><code>{answer.query}</code></pre>
                </details>
            )}
        </section>
    )
}

function QueryResult({ result }: { result: SelectAnswer }) {
    const [search, setSearch] = useState('')
    const [pageSize, setPageSize] = useState(10)
    const [page, setPage] = useState(0)
    if (result.rows.length === 0) return <p role="status">The query ran successfully and returned no results.</p>
    if (result.rows.length === 1 && result.columns.length === 1 && !result.moreResults) {
        return (
            <dl className="ask-question-scalar">
                <dt>{result.columns[0]}</dt>
                <dd className="ask-question-value" role="status">{result.rows[0][0] ?? 'No value'}</dd>
            </dl>
        )
    }

    const searchTerm = search.trim().toLowerCase()
    const matchingRows = result.rows.filter((row) => row.some((value) => value?.toLowerCase().includes(searchTerm)) || !searchTerm)
    const pageCount = Math.ceil(matchingRows.length / pageSize)

    return (
        <>
            <p role="status">{result.moreResults
                ? `Showing the first ${result.rows.length} results. Ask a more specific question to narrow the results.`
                : `${result.rows.length} ${result.rows.length === 1 ? 'result' : 'results'} returned.`}</p>
            <div className="instances-heading question-controls">
                <label>Search results
                    <input type="search" value={search} onChange={(event) => {
                        setSearch(event.target.value)
                        setPage(0)
                    }} />
                </label>
                <label>Results per page
                    <select value={pageSize} onChange={(event) => {
                        setPageSize(Number(event.target.value))
                        setPage(0)
                    }}>
                        {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
                    </select>
                </label>
            </div>
            {matchingRows.length === 0 ? <p role="status">No matching results.</p> : (
                <div className="ask-question-table">
                    <table className="question-counts">
                        <thead><tr>{result.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
                        <tbody>{matchingRows.slice(page * pageSize, (page + 1) * pageSize).map((row, index) => (
                            <tr key={index}>{row.map((value, column) => <td key={column}>{value ?? '—'}</td>)}</tr>
                        ))}</tbody>
                    </table>
                </div>
            )}
            {pageCount > 1 && (
                <nav className="pagination" aria-label="Answer result pages">
                    <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
                    <span role="status">Page {page + 1} of {pageCount}</span>
                    <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>Next</button>
                </nav>
            )}
        </>
    )
}
