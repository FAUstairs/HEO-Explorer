import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, X } from 'lucide-react'
import { authenticatedFetch } from './api'
import { programmeModuleAccountsQuery } from './advancedQuestionQueries'

type NamedResource = { iri: string; title: string }
type Module = NamedResource & { competencies: Map<string, NamedResource> }
type Account = NamedResource & { parents: Set<string>; modules: Map<string, Module> }
type Coverage = { annotated: number; total: number }
type AccountBranch = Account & { children: AccountBranch[]; coverage: Coverage }
type Regulation = NamedResource & { accounts: Map<string, Account> }
type AccountRow = Partial<Record<
    'regulation' | 'regulationTitle' | 'account' | 'accountTitle' | 'parent' | 'module' | 'moduleTitle' | 'competency' | 'competencyTitle',
    { value: string }
>>

function byTitle(a: NamedResource, b: NamedResource) {
    return a.title.localeCompare(b.title, 'en', { numeric: true }) || a.iri.localeCompare(b.iri)
}

function groupRegulations(rows: AccountRow[]): Regulation[] {
    const regulations = new Map<string, Regulation>()
    for (const row of rows) {
        const regulationIri = row.regulation?.value
        if (!regulationIri) continue
        const regulation = regulations.get(regulationIri) ?? {
            iri: regulationIri, title: row.regulationTitle?.value ?? regulationIri, accounts: new Map(),
        }
        regulations.set(regulationIri, regulation)
        const accountIri = row.account?.value
        if (!accountIri) continue
        const account = regulation.accounts.get(accountIri) ?? {
            iri: accountIri, title: row.accountTitle?.value ?? accountIri, parents: new Set(), modules: new Map(),
        }
        regulation.accounts.set(accountIri, account)
        if (row.parent?.value) account.parents.add(row.parent.value)
        const moduleIri = row.module?.value
        if (!moduleIri) continue
        const module = account.modules.get(moduleIri) ?? {
            iri: moduleIri, title: row.moduleTitle?.value ?? moduleIri, competencies: new Map(),
        }
        account.modules.set(moduleIri, module)
        const competencyIri = row.competency?.value
        if (competencyIri) {
            module.competencies.set(competencyIri, { iri: competencyIri, title: row.competencyTitle?.value ?? competencyIri })
        }
    }
    return [...regulations.values()].sort(byTitle)
}

function accountForest(accounts: Map<string, Account>): AccountBranch[] {
    const children = new Map<string, Account[]>()
    const roots: Account[] = []
    const sorted = [...accounts.values()].sort(byTitle)
    for (const account of sorted) {
        const parents = [...account.parents].filter((parent) => parent !== account.iri && accounts.has(parent))
        if (parents.length === 0) roots.push(account)
        for (const parent of parents) {
            const siblings = children.get(parent) ?? []
            siblings.push(account)
            children.set(parent, siblings)
        }
    }
    function coverageFor(account: Account): Coverage {
        const modules = new Set<string>()
        const annotated = new Set<string>()
        const seen = new Set<string>()
        const pending = [account]
        while (pending.length > 0) {
            const current = pending.pop()!
            if (seen.has(current.iri)) continue
            seen.add(current.iri)
            for (const module of current.modules.values()) {
                modules.add(module.iri)
                if (module.competencies.size > 0) annotated.add(module.iri)
            }
            pending.push(...(children.get(current.iri) ?? []))
        }
        return { annotated: annotated.size, total: modules.size }
    }

    const visited = new Set<string>()
    function branch(account: Account): AccountBranch[] {
        if (visited.has(account.iri)) return []
        visited.add(account.iri)
        return [{ ...account, coverage: coverageFor(account), children: (children.get(account.iri) ?? []).flatMap(branch) }]
    }
    return [...roots, ...sorted].flatMap(branch)
}

const percentFormat = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 })

function AccountCoverage({ title, annotated, total }: Coverage & { title: string }) {
    if (total === 0) return (
        <span className="annotation-coverage">
            <progress value={0} max={1} aria-hidden="true" style={{ borderColor: 'var(--border, #dce3ec)' }} />
            <span>0 / 0 · N/A</span>
        </span>
    )
    const ratio = annotated / total
    return (
        <span className="annotation-coverage">
            <progress value={annotated} max={total} aria-label={`Competency coverage for ${title}`}
                aria-valuetext={`${annotated} of ${total} modules, ${percentFormat.format(ratio)}`}
                style={{ '--annotation-coverage-hue': Math.round(120 * ratio) } as CSSProperties} />
            <span aria-hidden="true">{annotated} / {total} · {percentFormat.format(ratio)}</span>
        </span>
    )
}

function AccountList({ branches }: { branches: AccountBranch[] }) {
    return (
        <ul className="annotation-accounts">
            {branches.map(({ iri, title, modules, children, coverage }) => {
                const heading = (
                    <span className="annotation-account-heading">
                        <strong title={iri}>{title}</strong>
                        <AccountCoverage title={title} {...coverage} />
                    </span>
                )
                return (
                    <li key={iri}>
                        {modules.size === 0 && children.length === 0 ? heading : (
                            <details className="annotation-account">
                                <summary>{heading}</summary>
                                {modules.size > 0 && (
                                    <ul className="annotation-account-modules">
                                        {[...modules.values()].sort(byTitle).map((module) => {
                                            const annotated = module.competencies.size > 0
                                            const StatusIcon = annotated ? Check : X
                                            const status = annotated ? 'Has competency annotations' : 'No competency annotations'
                                            const title = (
                                                <span className="annotation-module-title">
                                                    <span className={annotated ? 'annotation-status present' : 'annotation-status missing'}
                                                        role="img" aria-label={status} title={status}>
                                                        <StatusIcon size={16} aria-hidden="true" />
                                                    </span>
                                                    <span className="annotation-module-name" title={module.iri}>{module.title}</span>
                                                </span>
                                            )
                                            return (
                                                <li key={module.iri}>
                                                    {annotated ? (
                                                        <details className="annotation-module-details">
                                                            <summary>{title}</summary>
                                                            <p>{[...module.competencies.values()].sort(byTitle).map(({ title }) => title).join(', ')}</p>
                                                        </details>
                                                    ) : title}
                                                </li>
                                            )
                                        })}
                                    </ul>
                                )}
                                {children.length > 0 && <AccountList branches={children} />}
                            </details>
                        )}
                    </li>
                )
            })}
        </ul>
    )
}

function setAccountDetailsOpen(programme: HTMLDetailsElement, open: boolean) {
    programme.querySelectorAll<HTMLDetailsElement>('.annotation-account').forEach((account) => { account.open = open })
}

export default function ModuleAccountTree({ programme, totalModules, endpoint, token }: {
    programme: NamedResource & { annotatedModules: number }
    totalModules?: number
    endpoint: string
    token: string
}) {
    const programmeDetails = useRef<HTMLDetailsElement>(null)
    const expandWhenLoaded = useRef(false)
    const [requested, setRequested] = useState(false)
    const [regulations, setRegulations] = useState<Regulation[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
        if (!requested) return
        const controller = new AbortController()
        async function load() {
            try {
                const response = await authenticatedFetch(endpoint, token, {
                    method: 'POST',
                    body: new URLSearchParams({ query: programmeModuleAccountsQuery(programme.iri) }),
                    signal: controller.signal,
                })
                if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
                const data = await response.json() as { results: { bindings: AccountRow[] } }
                if (!controller.signal.aborted) setRegulations(groupRegulations(data.results.bindings))
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Module accounts could not be loaded.')
            }
        }
        void load()
        return () => controller.abort()
    }, [attempt, endpoint, programme.iri, requested, token])

    useEffect(() => {
        const programme = programmeDetails.current
        if (!programme || !regulations || !expandWhenLoaded.current) return
        setAccountDetailsOpen(programme, true)
        expandWhenLoaded.current = false
    }, [regulations])

    function expandAll() {
        const programme = programmeDetails.current
        if (!programme) return
        programme.open = true
        if (regulations) {
            setAccountDetailsOpen(programme, true)
        } else {
            expandWhenLoaded.current = true
            setRequested(true)
        }
    }

    function collapseAll() {
        expandWhenLoaded.current = false
        const programme = programmeDetails.current
        if (!programme) return
        setAccountDetailsOpen(programme, false)
        programme.open = false
    }

    return (
        <div className="annotation-programme">
            <div className="annotation-programme-actions">
                <button className="refresh-button" type="button" onClick={expandAll}
                    aria-label={`Expand all for ${programme.title}`}>Expand all</button>
                <button className="refresh-button" type="button" onClick={collapseAll}
                    aria-label={`Collapse all for ${programme.title}`}>Collapse all</button>
            </div>
            <details className="annotation-programme-details" ref={programmeDetails} onToggle={(event) => {
                if (event.currentTarget.open) setRequested(true)
            }}>
                <summary>
                    <span className="annotation-account-heading">
                        <strong title={programme.iri}>{programme.title}</strong>
                        {totalModules !== undefined && totalModules >= programme.annotatedModules
                            ? <AccountCoverage title={programme.title} annotated={programme.annotatedModules} total={totalModules} />
                            : <span className="annotation-coverage">{programme.annotatedModules} competency-linked modules</span>}
                    </span>
                </summary>
                {requested && !error && regulations === null && <p role="status">Loading module accounts …</p>}
                {error && (
                    <div className="notice error">
                        <p role="alert">{error}</p>
                        <button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1) }}>Try again</button>
                    </div>
                )}
                {regulations?.length === 0 && <p>No examination regulations were found.</p>}
                {regulations?.map((regulation) => (
                    <section className="annotation-regulation" key={regulation.iri}>
                        <h3 title={regulation.iri}>Examination regulation {regulation.title}</h3>
                        {regulation.accounts.size > 0
                            ? <AccountList branches={accountForest(regulation.accounts)} />
                            : <p>No module accounts were found.</p>}
                    </section>
                ))}
            </details>
        </div>
    )
}
