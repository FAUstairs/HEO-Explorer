import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { authenticatedFetch } from './api'
import { annotatedProgrammesQuery, programmeModuleTotalsQuery } from './advancedQuestionQueries'
import ModuleAccountTree from './ModuleAccountTree'

type Programme = { iri: string; title: string; annotatedModules: number }
type ProgrammeRow = Record<'programme' | 'programmeTitle' | 'annotatedModules', { value: string }>
type TotalRow = Record<'programme' | 'totalModules', { value: string }>
const pageSizes = [10, 20, 50, 100]
const totalsBatchSize = 10

function parseProgrammes(rows: ProgrammeRow[]): Programme[] {
    return rows.map((row) => ({
        iri: row.programme.value,
        title: row.programmeTitle.value,
        annotatedModules: Number(row.annotatedModules.value),
    })).sort((a, b) => a.title.localeCompare(b.title, 'en') || a.iri.localeCompare(b.iri))
}

export default function ModuleAnnotation({ endpoint, token }: { endpoint: string; token: string }) {
    const [programmes, setProgrammes] = useState<Programme[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [search, setSearch] = useState('')
    const [pageSize, setPageSize] = useState(pageSizes[0])
    const [page, setPage] = useState(0)
    const [totals, setTotals] = useState(new Map<string, number>())
    const [totalsError, setTotalsError] = useState(false)
    const [totalsAttempt, setTotalsAttempt] = useState(0)
    const matchingProgrammes = useMemo(() => {
        const terms = search.trim().toLowerCase().split(/\s+/)
        return programmes?.filter(({ title }) => {
            const name = title.toLowerCase()
            return terms.every((term) => name.includes(term))
        }) ?? []
    }, [programmes, search])
    const pageCount = Math.ceil(matchingProgrammes.length / pageSize)
    const visibleProgrammes = useMemo(
        () => matchingProgrammes.slice(page * pageSize, (page + 1) * pageSize),
        [matchingProgrammes, page, pageSize],
    )

    function openPage(next: number) {
        setPage(next)
        window.scrollTo(0, 0)
    }

    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            try {
                const response = await authenticatedFetch(endpoint, token, {
                    method: 'POST',
                    body: new URLSearchParams({ query: annotatedProgrammesQuery }),
                    signal: controller.signal,
                })
                if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
                const data = await response.json() as { results: { bindings: ProgrammeRow[] } }
                if (!controller.signal.aborted) {
                    setProgrammes(parseProgrammes(data.results.bindings))
                    setPage(0)
                }
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Module annotations could not be loaded.')
            }
        }
        void load()
        return () => controller.abort()
    }, [attempt, endpoint, token])

    useEffect(() => {
        const controller = new AbortController()
        setTotalsError(false)
        if (visibleProgrammes.length === 0) return
        async function loadTotals() {
            try {
                for (let index = 0; index < visibleProgrammes.length; index += totalsBatchSize) {
                    if (controller.signal.aborted) return
                    const batch = visibleProgrammes.slice(index, index + totalsBatchSize)
                    const response = await authenticatedFetch(endpoint, token, {
                        method: 'POST',
                        body: new URLSearchParams({ query: programmeModuleTotalsQuery(batch.map(({ iri }) => iri)) }),
                        signal: controller.signal,
                    })
                    if (!response.ok) throw new Error('Could not load module totals.')
                    const data = await response.json() as { results: { bindings: TotalRow[] } }
                    if (controller.signal.aborted) return
                    const received = new Map(data.results.bindings.map((row) => [
                        row.programme.value, Number(row.totalModules.value),
                    ]))
                    setTotals((current) => new Map([...current, ...received]))
                    if (batch.some(({ iri, annotatedModules }) => (received.get(iri) ?? 0) < annotatedModules)) {
                        setTotalsError(true)
                    }
                }
            } catch {
                if (!controller.signal.aborted) setTotalsError(true)
            }
        }
        const timer = window.setTimeout(() => void loadTotals(), 250)
        return () => {
            window.clearTimeout(timer)
            controller.abort()
        }
    }, [endpoint, token, totalsAttempt, visibleProgrammes])

    return (
        <section className="property-page">
            <h1>Module Annotation</h1>
            {!error && !programmes && <p role="status">Loading study programmes and modules …</p>}
            {error && (
                <div className="notice error">
                    <p role="alert">{error}</p>
                    <button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1) }}>Try again</button>
                </div>
            )}
            {programmes && (programmes.length === 0 ? <p>No study programmes with competency-linked modules were found.</p> : (
                <>
                    <div className="instances-heading question-controls">
                        <div className="search-field">
                            <Search size={16} aria-hidden="true" />
                            <input type="search" aria-label="Search study programmes" placeholder="Search study programmes …"
                                value={search} onChange={(event) => {
                                    setSearch(event.target.value)
                                    setPage(0)
                                }} />
                        </div>
                        <label>Study programmes per page
                            <select value={pageSize} onChange={(event) => {
                                setPageSize(Number(event.target.value))
                                setPage(0)
                            }}>
                                {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
                            </select>
                        </label>
                    </div>
                    {matchingProgrammes.length === 0 && <p role="status">No study programmes match your search.</p>}
                    {totalsError && (
                        <div className="notice error">
                            <p role="alert">Some module totals could not be loaded.</p>
                            <button type="button" onClick={() => setTotalsAttempt((value) => value + 1)}>Try again</button>
                        </div>
                    )}
                    <div className="annotation-programmes">
                        {visibleProgrammes.map((programme) => (
                            <ModuleAccountTree key={programme.iri} programme={programme} endpoint={endpoint} token={token}
                                totalModules={totals.get(programme.iri)} />
                        ))}
                    </div>
                    {pageCount > 1 && (
                        <nav className="pagination" aria-label="Study programme pages">
                            <button type="button" disabled={page === 0} onClick={() => openPage(page - 1)}>Previous</button>
                            <span role="status">Page {page + 1} of {pageCount}</span>
                            <button type="button" disabled={page >= pageCount - 1} onClick={() => openPage(page + 1)}>Next</button>
                        </nav>
                    )}
                </>
            ))}
        </section>
    )
}
