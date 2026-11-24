import { authenticatedFetch } from './api'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
    moduleProgrammesQuery, programmeModuleNamesQuery, programmePortfoliosQuery, regulationCatalogueQuery,
    regulationModulesQuery, sharedModulesQuery,
} from './advancedQuestionQueries'
import { ArrowDown, ArrowDownUp, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'

const degreeCountsQuery = `
PREFIX heo: <https://mathhub.info/heo#>

SELECT ?group (?group AS ?label) (COUNT(DISTINCT ?program) AS ?count) WHERE {
    ?program a heo:CourseOfStudy ;
        heo:credentialForProgram/heo:certificateTitle ?title .
    BIND(STR(?title) AS ?group)
}
GROUP BY ?group
ORDER BY DESC(?count) LCASE(?group)`

const subjectCountsQuery = `
PREFIX heo: <https://mathhub.info/heo#>

SELECT ?group (COALESCE(SAMPLE(STR(?name)), STR(?group)) AS ?label) (COUNT(DISTINCT ?program) AS ?count) WHERE {
    ?group a heo:Subject .
    OPTIONAL { ?group heo:subjectName ?name . }
    OPTIONAL { ?program a heo:CourseOfStudy ; heo:teachesSubject ?group . }
}
GROUP BY ?group
ORDER BY DESC(?count) LCASE(?label) ?group`

const moduleCountsQuery = `
PREFIX heo: <https://mathhub.info/heo#>

SELECT ?group (COALESCE(SAMPLE(STR(?name)), STR(?group)) AS ?label) (COALESCE(?moduleCount, 0) AS ?count) WHERE {
    ?group a heo:CourseOfStudy .
    OPTIONAL { ?group heo:programTitle ?name . }
    OPTIONAL {
        SELECT ?group (COUNT(DISTINCT ?module) AS ?moduleCount) WHERE {
            ?regulation heo:definesProgram ?group .
            ?account heo:moduleAccountDefinedBy ?regulation .
            ?entry heo:isInModuleAccount ?account ; heo:basedOnModule ?module .
            ?module a heo:Module .
        }
        GROUP BY ?group
    }
}
GROUP BY ?group ?moduleCount`

const peopleCountsQuery = `
PREFIX heo: <https://mathhub.info/heo#>

SELECT ?group (COALESCE(SAMPLE(STR(?name)), STR(?group)) AS ?label) (COALESCE(?peopleCount, 0) AS ?count) WHERE {
    ?group a heo:Institution .
    OPTIONAL { ?group heo:institutionName ?name . }
    OPTIONAL {
        SELECT ?group (COUNT(DISTINCT ?person) AS ?peopleCount) WHERE {
            ?person a heo:Person ; heo:hasRoleAssignment/heo:atInstitution ?group .
        }
        GROUP BY ?group
    }
}
GROUP BY ?group ?peopleCount`

const roleCountsQuery = `
PREFIX heo: <https://mathhub.info/heo#>

SELECT ?group (COALESCE(MIN(STR(?title)), STRAFTER(STR(?group), "#")) AS ?label)
       (COUNT(DISTINCT ?person) AS ?count) WHERE {
    ?person a heo:Person ; heo:hasRoleAssignment ?assignment .
    ?assignment a ?group .
    FILTER(STRSTARTS(STR(?group), STR(heo:)) && ?group != heo:RoleAssignment)
    OPTIONAL {
        ?assignment heo:roleTitle ?title .
        FILTER(LANGMATCHES(LANG(?title), "en"))
    }
}
GROUP BY ?group`

type Question = {
    id: string
    title: string
    column: string
    countColumn: string
    empty: string
    query: string
    expand?: (id: string, connection: QueryConnection) => ReactNode
}

const questions: Question[] = [
    { id: 'degree', title: 'How many study programmes are there per degree?', column: 'Degree', countColumn: 'Study programmes',
        empty: 'No study programmes with an associated degree were found.', query: degreeCountsQuery },
    { id: 'subject', title: 'How many study programmes are there per subject?', column: 'Subject', countColumn: 'Study programmes',
        empty: 'No subjects were found.', query: subjectCountsQuery },
    { id: 'modules', title: 'How many distinct modules are offered in each study programme?', column: 'Study programme', countColumn: 'Modules',
        empty: 'No study programmes were found.', query: moduleCountsQuery },
    { id: 'people', title: 'How many people work in each organisational unit?', column: 'Organisational unit', countColumn: 'People',
        empty: 'No organisational units were found.', query: peopleCountsQuery },
    { id: 'roles', title: 'How many people are assigned to each role?', column: 'Role', countColumn: 'People',
        empty: 'No role assignments were found.', query: roleCountsQuery },
    { id: 'shared-modules', title: 'Which modules are shared by the most study programmes?', column: 'Module', countColumn: 'Study programmes',
        empty: 'No modules are shared by multiple study programmes.', query: sharedModulesQuery, expand: moduleProgrammes },
]

type Binding = { value: string }
type NamedRow = { group: Binding; label: Binding }
type CountRow = NamedRow & { count: Binding; detail?: Binding }
type QueryConnection = { endpoint: string; token: string }
type Answer = { status: 'loading' } | { status: 'ready'; rows: CountRow[] } | { status: 'error'; message: string }
type SortColumn = 'label' | 'count'
type SortDirection = 'ascending' | 'descending'
const nameOrder = new Intl.Collator('en')
const pageSizes = [10, 20, 50, 100]

export default function Questions({ endpoint, token }: { endpoint: string; token: string }) {
    return (
        <section className="property-page">
            <h1>Questions</h1>
            <ul className="question-list">
                {questions.map((question) => <QuestionItem key={question.id} question={question} endpoint={endpoint} token={token} />)}
                <AdvancedQuestion title="Which modules were added or removed between two examination regulations?">
                    <RegulationComparison endpoint={endpoint} token={token} />
                </AdvancedQuestion>
                <AdvancedQuestion title="Which study programmes have the most similar module portfolios?">
                    <ProgrammeSimilarity endpoint={endpoint} token={token} />
                </AdvancedQuestion>
            </ul>
        </section>
    )
}

function QuestionItem({ question, endpoint, token }: { question: typeof questions[number]; endpoint: string; token: string }) {
    const [answer, setAnswer] = useState<Answer | null>(null)
    async function loadCounts() {
        setAnswer({ status: 'loading' })
        try {
            const rows = await queryRows<CountRow>({ endpoint, token }, question.query)
            setAnswer({ status: 'ready', rows })
        } catch (error) {
            setAnswer({ status: 'error', message: queryError(error) })
        }
    }

    return (
        <li>
            <button type="button" className="instance-row" aria-expanded={answer !== null} aria-controls={question.id + '-counts'}
                disabled={answer?.status === 'loading'} onClick={() => answer ? setAnswer(null) : void loadCounts()}>
                {question.title} <ChevronRight size={14} aria-hidden="true" />
            </button>
            <div id={question.id + '-counts'} hidden={answer === null}>
                {answer?.status === 'loading' && <p role="status">Counting {question.countColumn.toLowerCase()} …</p>}
                {answer?.status === 'error' && (
                    <div className="notice error">
                        <p role="alert">{answer.message}</p>
                        <button type="button" onClick={() => void loadCounts()}>Try again</button>
                    </div>
                )}
                {answer?.status === 'ready' && (answer.rows.length === 0
                    ? <p>{question.empty}</p>
                    : <ResultsTable rows={answer.rows} columnLabel={question.column} countColumn={question.countColumn}
                        renderLabel={question.expand ? (id, label) => (
                            <DeferredDetails title={label}>{question.expand?.(id, { endpoint, token })}</DeferredDetails>
                        ) : undefined} />
                )}
            </div>
        </li>
    )
}

function ResultsTable({ rows, columnLabel, countColumn, renderLabel, formatCount = (count) => count.toLocaleString('en-GB') }: {
    rows: CountRow[]
    columnLabel: string
    countColumn: string
    renderLabel?: (id: string, label: string) => ReactNode
    formatCount?: (count: number) => string
}) {
    const [search, setSearch] = useState('')
    const [pageSize, setPageSize] = useState(pageSizes[0])
    const [page, setPage] = useState(0)
    const [sort, setSort] = useState<{ column: SortColumn; direction: SortDirection }>({ column: 'count', direction: 'descending' })
    const searchTerm = search.trim().toLocaleLowerCase('en')
    const matchingRows = rows.filter(({ label, detail }) => (
        [label.value, detail?.value].some((value) => value?.toLocaleLowerCase('en').includes(searchTerm))
    )).sort((a, b) => {
        const byName = nameOrder.compare(a.label.value, b.label.value)
        const order = sort.direction === 'ascending' ? 1 : -1
        return sort.column === 'label'
            ? order * byName
            : order * (Number(a.count.value) - Number(b.count.value)) || byName
    })
    const pageCount = Math.ceil(matchingRows.length / pageSize)
    const pageRows = matchingRows.slice(page * pageSize, (page + 1) * pageSize)

    function sortBy(column: SortColumn) {
        setPage(0)
        setSort((current) => ({
            column,
            direction: current.column === column
                ? (current.direction === 'ascending' ? 'descending' : 'ascending')
                : (column === 'label' ? 'ascending' : 'descending'),
        }))
    }

    return (
        <>
        <div className="instances-heading question-controls">
            <div className="search-field">
                <Search size={16} aria-hidden="true" />
                <input type="search" value={search} placeholder={`Search by ${columnLabel.toLowerCase()} name …`}
                    aria-label={`Search by ${columnLabel.toLowerCase()} name`} onChange={(event) => {
                        setSearch(event.target.value)
                        setPage(0)
                    }} />
            </div>
            <label>Results per page
                <select value={pageSize} onChange={(event) => {
                    setPageSize(Number(event.target.value))
                    setPage(0)
                }}>
                    {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
            </label>
        </div>
        {matchingRows.length === 0 ? <p role="status">No matching results.</p> : (
            <table className="question-counts">
                <thead><tr>
                    {(['label', 'count'] as const).map((column) => {
                        const direction = sort.column === column ? sort.direction : undefined
                        const SortIcon = direction === 'ascending' ? ArrowUp : direction === 'descending' ? ArrowDown : ArrowDownUp
                        return (
                            <th key={column} scope="col" aria-sort={direction}>
                                <button type="button" onClick={() => sortBy(column)}>
                                    {column === 'label' ? columnLabel : countColumn} <SortIcon size={14} aria-hidden="true" />
                                </button>
                            </th>
                        )
                    })}
                </tr></thead>
                <tbody>{pageRows.map(({ group, label, count, detail }) => (
                    <tr key={group.value}><td>{renderLabel ? renderLabel(group.value, label.value) : label.value}{detail && <small className="question-result-detail">{detail.value}</small>}</td><td>{formatCount(Number(count.value))}</td></tr>
                ))}</tbody>
            </table>
        )}
        {pageCount > 1 && (
            <nav className="pagination" aria-label={`${columnLabel} results pages`}>
                <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    <ChevronLeft size={15} aria-hidden="true" /> Previous
                </button>
                <span role="status">Page {page + 1} of {pageCount}</span>
                <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
                    Next <ChevronRight size={15} aria-hidden="true" />
                </button>
            </nav>
        )}
        </>
    )
}

async function queryRows<Row>({ endpoint, token }: QueryConnection, query: string, signal?: AbortSignal): Promise<Row[]> {
    const response = await authenticatedFetch(endpoint, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ query }),
        signal,
    })
    if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
    const data = await response.json() as { results: { bindings: Row[] } }
    return data.results.bindings
}

function queryError(error: unknown) {
    return error instanceof Error ? error.message : 'The answer could not be loaded.'
}

function QueryResults<Row>({ endpoint, token, query, children }: QueryConnection & {
    query: string
    children: (rows: Row[]) => ReactNode
}) {
    const [result, setResult] = useState<{ rows: Row[] } | { error: string } | null>(null)
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        void queryRows<Row>({ endpoint, token }, query, controller.signal).then(
            (rows) => { if (!controller.signal.aborted) setResult({ rows }) },
            (error) => { if (!controller.signal.aborted) setResult({ error: queryError(error) }) },
        )
        return () => controller.abort()
    }, [endpoint, token, query, attempt])

    if (!result) return <p role="status">Loading …</p>
    if ('error' in result) return (
        <div className="notice error">
            <p role="alert">{result.error}</p>
            <button type="button" onClick={() => { setResult(null); setAttempt(attempt + 1) }}>Try again</button>
        </div>
    )
    return children(result.rows)
}

function AdvancedQuestion({ title, children }: { title: string; children: ReactNode }) {
    const [open, setOpen] = useState(false)
    return (
        <li>
            <button type="button" className="instance-row" aria-expanded={open} onClick={() => setOpen(!open)}>
                {title} <ChevronRight size={14} aria-hidden="true" />
            </button>
            {open && <div className="question-controls">{children}</div>}
        </li>
    )
}

function DeferredDetails({ title, children }: { title: string; children: ReactNode }) {
    const [loaded, setLoaded] = useState(false)
    return (
        <details onToggle={(event) => { if (event.currentTarget.open) setLoaded(true) }}>
            <summary>{title}</summary>
            {loaded && children}
        </details>
    )
}

function moduleProgrammes(module: string, connection: QueryConnection) {
    return (
        <QueryResults<NamedRow> {...connection} query={moduleProgrammesQuery(module)}>
            {(rows) => <NamedResults rows={rows} empty="No associated study programmes were found." />}
        </QueryResults>
    )
}

function NamedResults({ rows, empty }: { rows: NamedRow[]; empty: string }) {
    if (!rows.length) return <p>{empty}</p>
    return (
        <ul>
            {[...rows].sort((a, b) => nameOrder.compare(a.label.value, b.label.value)).map(({ group, label }) => (
                <li key={group.value} title={group.value}>{label.value}</li>
            ))}
        </ul>
    )
}

function ProgrammePicker({ options, value, onChange }: {
    options: NamedRow[]
    value: string
    onChange: (value: string) => void
}) {
    const [search, setSearch] = useState('')
    const term = search.trim().toLocaleLowerCase('en')
    const matching = options.filter(({ group, label }) => group.value === value || label.value.toLocaleLowerCase('en').includes(term))
        .sort((a, b) => nameOrder.compare(a.label.value, b.label.value))
    return (
        <div className="question-selectors">
            <label>Find a study programme
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <label>Study programme
                <select value={value} onChange={(event) => onChange(event.target.value)}>
                    <option value="">Select a study programme</option>
                    {matching.map(({ group, label }) => <option key={group.value} value={group.value}>{label.value}</option>)}
                </select>
            </label>
        </div>
    )
}

type RegulationRow = NamedRow & { regulation: Binding; code: Binding }

function RegulationComparison(connection: QueryConnection) {
    return (
        <QueryResults<RegulationRow> {...connection} query={regulationCatalogueQuery}>
            {(rows) => {
                const regulationCounts = new Map<string, number>()
                for (const { group } of rows) regulationCounts.set(group.value, (regulationCounts.get(group.value) ?? 0) + 1)
                const comparable = rows.filter(({ group }) => (regulationCounts.get(group.value) ?? 0) > 1)
                return comparable.length
                    ? <RegulationPicker rows={comparable} connection={connection} />
                    : <p>No study programmes with multiple examination regulations were found.</p>
            }}
        </QueryResults>
    )
}

function RegulationPicker({ rows, connection }: { rows: RegulationRow[]; connection: QueryConnection }) {
    const [programme, setProgramme] = useState('')
    const [before, setBefore] = useState('')
    const [after, setAfter] = useState('')
    const programmes = [...new Map(rows.map((row) => [row.group.value, row])).values()]
    const regulations = rows.filter((row) => row.group.value === programme)
        .sort((a, b) => nameOrder.compare(a.code.value, b.code.value))
    const options = (other: string) => (
        <>
            <option value="">Select a regulation</option>
            {regulations.map(({ regulation, code }) => (
                <option key={regulation.value} value={regulation.value} disabled={regulation.value === other}>{code.value}</option>
            ))}
        </>
    )
    return (
        <>
            <ProgrammePicker options={programmes} value={programme} onChange={(value) => {
                setProgramme(value)
                setBefore('')
                setAfter('')
            }} />
            {programme && (
                <div className="question-selectors">
                    <label>Compare from<select value={before} onChange={(event) => setBefore(event.target.value)}>{options(after)}</select></label>
                    <label>Compare to<select value={after} onChange={(event) => setAfter(event.target.value)}>{options(before)}</select></label>
                </div>
            )}
            {before && after && (
                <QueryResults<NamedRow & { regulation: Binding }> key={JSON.stringify([before, after])}
                    {...connection} query={regulationModulesQuery([before, after])}>
                    {(modules) => {
                        const from = new Set(modules.filter((row) => row.regulation.value === before).map((row) => row.group.value))
                        const to = new Set(modules.filter((row) => row.regulation.value === after).map((row) => row.group.value))
                        const changes = modules.filter(({ group }) => from.has(group.value) !== to.has(group.value))
                            .map(({ group, label }) => ({ group, label, count: { value: to.has(group.value) ? '1' : '-1' } }))
                        return changes.length
                            ? <ResultsTable rows={changes} columnLabel="Module" countColumn="Change" formatCount={(count) => count > 0 ? 'Added' : 'Removed'} />
                            : <p>No module changes found between these regulations.</p>
                    }}
                </QueryResults>
            )}
        </>
    )
}

type PortfolioRow = NamedRow & { modules: Binding }

function ProgrammeSimilarity(connection: QueryConnection) {
    return (
        <QueryResults<PortfolioRow> {...connection} query={programmePortfoliosQuery}>
            {(rows) => rows.length
                ? <SimilarityPicker rows={rows} connection={connection} />
                : <p>No study programmes with associated modules were found.</p>}
        </QueryResults>
    )
}

function SimilarityPicker({ rows, connection }: { rows: PortfolioRow[]; connection: QueryConnection }) {
    const [programme, setProgramme] = useState('')
    const portfolios = useMemo(() => new Map(rows.map(({ group, modules }) => [
        group.value, new Set(modules.value.split(' ').filter(Boolean).map((module) => decodeURIComponent(module))),
    ])), [rows])
    const selectedModules = portfolios.get(programme)
    const matches = selectedModules ? rows.flatMap(({ group, label }) => {
        if (group.value === programme) return []
        const modules = portfolios.get(group.value)!
        const common = [...modules].filter((module) => selectedModules.has(module)).length
        const similarity = common / (selectedModules.size + modules.size - common)
        return [{ group, label, count: { value: String(similarity) }, detail: { value: `${common} shared modules` } }]
    }) : []
    const percent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 })
    return (
        <>
            <ProgrammePicker options={rows} value={programme} onChange={setProgramme} />
            {selectedModules && (
                <>
                    <p>Similarity is the share of distinct modules that both programmes have in common.</p>
                    {matches.length ? (
                        <ResultsTable key={programme} rows={matches} columnLabel="Study programme" countColumn="Similarity"
                            formatCount={(score) => percent.format(score)} renderLabel={(id, label) => {
                                const otherModules = portfolios.get(id)!
                                return (
                                    <DeferredDetails title={label}>
                                        <QueryResults<NamedRow> {...connection} query={programmeModuleNamesQuery([programme, id])}>
                                            {(modules) => <>
                                                <p><strong>Shared modules</strong></p>
                                                <NamedResults rows={modules.filter(({ group }) => selectedModules.has(group.value) && otherModules.has(group.value))} empty="None." />
                                                <p><strong>Only in the selected programme</strong></p>
                                                <NamedResults rows={modules.filter(({ group }) => selectedModules.has(group.value) && !otherModules.has(group.value))} empty="None." />
                                                <p><strong>Only in this programme</strong></p>
                                                <NamedResults rows={modules.filter(({ group }) => !selectedModules.has(group.value) && otherModules.has(group.value))} empty="None." />
                                            </>}
                                        </QueryResults>
                                    </DeferredDetails>
                                )
                            }} />
                    ) : <p>No other programmes with associated modules were found.</p>}
                </>
            )}
        </>
    )
}
