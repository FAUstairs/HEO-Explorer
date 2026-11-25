import ExplorerHeader from './ExplorerHeader'
import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, LoaderCircle, RefreshCw } from 'lucide-react'
import { apiUrl, authenticatedFetch } from './api'
import { classNamespaces, type ClassNamespace } from './classNamespaces'
import './tbox.css'

const QUERY_ENDPOINT = apiUrl('/api/query')
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class'
const RDFS_CLASS = 'http://www.w3.org/2000/01/rdf-schema#Class'
const OWL_ON_PROPERTY = 'http://www.w3.org/2002/07/owl#onProperty'
const OWL_SOME_VALUES_FROM = 'http://www.w3.org/2002/07/owl#someValuesFrom'
const OWL_ALL_VALUES_FROM = 'http://www.w3.org/2002/07/owl#allValuesFrom'

type Binding = { value?: string; type?: string }
type Row = Record<string, Binding | undefined>

type Triple = {
  subject: string
  predicate: string
  object: string
  objectType: string
}

type Property = {
  iri: string
  kind: string
  comment: string
  domains: string[]
  ranges: string[]
}

const tboxQuery = (namespace: ClassNamespace) => `
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX ontology: <${classNamespaces[namespace]}>

SELECT DISTINCT ?subject ?predicate ?object
WHERE {
  {
    ?subject a ?resourceType .
    VALUES ?resourceType { owl:Class rdfs:Class owl:DatatypeProperty owl:ObjectProperty }
    ?subject ?predicate ?object .
    FILTER(STRSTARTS(STR(?subject), STR(ontology:)))
    VALUES ?predicate {
      rdf:type
      rdfs:domain
      rdfs:range
      rdfs:comment
      rdfs:subPropertyOf
    }
  }
  UNION {
    ?subject rdfs:subClassOf ?object .
    FILTER(STRSTARTS(STR(?subject), STR(ontology:)))
    BIND(rdfs:subClassOf AS ?predicate)
  }
  UNION {
    ?class rdfs:subClassOf ?subject .
    ?subject ?predicate ?object .
    FILTER(STRSTARTS(STR(?class), STR(ontology:)))
    VALUES ?predicate {
      owl:onProperty
      owl:someValuesFrom
      owl:allValuesFrom
      owl:hasValue
      owl:minCardinality
      owl:maxCardinality
      owl:cardinality
    }
  }
}
ORDER BY STR(?subject) STR(?predicate) STR(?object)`

function valueOf(binding: Binding | undefined): string {
  if (!binding?.value) return ''
  return binding.type === 'bnode' ? `_:${binding.value}` : binding.value
}

function localName(value: string): string {
  return value.split(/[/#]/).pop() || value
}

function isBlankNode(value: string): boolean {
  return value.startsWith('_:')
}

function parseTriples(payload: unknown): Triple[] {
  const response = payload as { results?: { bindings?: Row[] }; bindings?: Row[] }
  const rows = response.results?.bindings ?? response.bindings ?? []
  return rows.map((row) => ({
    subject: valueOf(row.subject),
    predicate: valueOf(row.predicate),
    object: valueOf(row.object),
    objectType: row.object?.type ?? 'literal',
  })).filter((triple) => triple.subject && triple.predicate && triple.object)
}

async function loadTriples(token: string, namespace: ClassNamespace, signal: AbortSignal): Promise<Triple[]> {
  const response = await authenticatedFetch(QUERY_ENDPOINT, token, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ query: tboxQuery(namespace) }),
  })
  if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
  return parseTriples(await response.json())
}

type TBoxProps = {
  token: string
  onLogout: () => void
  onChangePassword: () => void
  onAdmin?: () => void
  onBack?: () => void
}

export default function TBox({ token, onLogout, onChangePassword, onAdmin, onBack }: TBoxProps): JSX.Element {
  const [triples, setTriples] = useState<Triple[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [namespace, setNamespace] = useState<ClassNamespace>('HEO')
  const [reload, setReload] = useState(0)

  function refresh() {
    setLoading(true)
    setError(null)
    setReload((count) => count + 1)
  }

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    setLoading(true)
    setError(null)
    void loadTriples(token, namespace, signal)
      .then((result) => {
        if (!signal.aborted) setTriples(result)
      })
      .catch((cause) => {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'The TBox could not be loaded.')
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [namespace, reload, token])

  const namespaceIri = classNamespaces[namespace]
  const classes = [...new Set(triples.flatMap(({ subject, predicate, object }) => {
    if (predicate === RDF_TYPE && (object === OWL_CLASS || object === RDFS_CLASS)) return [subject]
    if (predicate === RDFS_SUBCLASS) return [subject, object]
    return []
  }).filter((iri) => iri.startsWith(namespaceIri)))].sort()
  const properties = [...new Map(triples
    .filter(({ predicate, object }) =>
      predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      && (object.endsWith('#DatatypeProperty') || object.endsWith('#ObjectProperty')))
    .map(({ subject, object }) => [subject, {
      iri: subject,
      kind: localName(object),
      comment: triples.find((triple) => triple.subject === subject
        && triple.predicate === 'http://www.w3.org/2000/01/rdf-schema#comment')?.object ?? '',
      domains: [...new Set(triples.filter((triple) => triple.subject === subject
        && triple.predicate === 'http://www.w3.org/2000/01/rdf-schema#domain').map((triple) => triple.object))],
      ranges: [...new Set(triples.filter((triple) => triple.subject === subject
        && triple.predicate === 'http://www.w3.org/2000/01/rdf-schema#range').map((triple) => triple.object))],
    } satisfies Property])).values()]

  const subclassesOf = (classIri: string) => triples
    .filter((triple) => triple.predicate === RDFS_SUBCLASS && triple.object === classIri)
    .map((triple) => triple.subject)
  const parentClassesOf = (classIri: string) => triples
    .filter((triple) => triple.subject === classIri && triple.predicate === RDFS_SUBCLASS)
    .map((triple) => triple.object)
  const namedParentClassesOf = (classIri: string) => parentClassesOf(classIri).filter((parentIri) => !isBlankNode(parentIri))
  const restrictionsOf = (classIri: string) => parentClassesOf(classIri).filter(isBlankNode)
  const restrictionDescription = (restrictionIri: string) => {
    const restrictionTriples = triples.filter((triple) => triple.subject === restrictionIri)
    const property = restrictionTriples.find((triple) => triple.predicate === OWL_ON_PROPERTY)?.object
    const someTarget = restrictionTriples.find((triple) => triple.predicate === OWL_SOME_VALUES_FROM)?.object
    const allTarget = restrictionTriples.find((triple) => triple.predicate === OWL_ALL_VALUES_FROM)?.object
    if (property && someTarget) return `${localName(property)} some ${localName(someTarget)}`
    if (property && allTarget) return `${localName(property)} only ${localName(allTarget)}`
    return 'Anonymous class restriction'
  }
  const formatParentClass = (parentIri: string) => isBlankNode(parentIri)
    ? `Restriction: ${restrictionDescription(parentIri)}`
    : localName(parentIri)
  const outgoingProperties = (classIri: string) => properties.filter((property) => property.domains.includes(classIri))
  const incomingProperties = (classIri: string) => properties.filter((property) => property.ranges.includes(classIri) && property.kind === 'ObjectProperty')

  return (
    <main className="shell tbox-page">
      <ExplorerHeader onHome={onBack} onAdmin={onAdmin} onLogout={onLogout} onChangePassword={onChangePassword} title="TBox">
        {onBack && <button className="refresh-button" onClick={onBack}><ArrowLeft size={16} /> Back to classes</button>}
        <button className="refresh-button" onClick={refresh} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </ExplorerHeader>

      <section className="property-page">
        <p className="eyebrow">Terminological box</p>
        <h1>{namespace} ontology TBox</h1>
        <p className="intro">Classes and all triples that define their datatype properties, object properties and subclass relations.</p>
        <div className="diagram-tabs tbox-namespace-tabs" role="group" aria-label="Ontology namespace">
          {(['HEO', 'ULO'] as const).map((option) => (
            <button key={option} className={namespace === option ? 'active' : ''} aria-pressed={namespace === option} onClick={() => {
              if (option === namespace) return
              setLoading(true)
              setError(null)
              setNamespace(option)
            }}>{option}</button>
          ))}
        </div>

        {error && <div className="notice error"><AlertCircle size={20} /><div><strong>Loading failed</strong><p>{error}</p></div><button onClick={refresh}>Try again</button></div>}
        {loading && <div className="loading"><LoaderCircle className="spin" size={28} /><span>Loading TBox triples …</span></div>}

        {!loading && !error && <>
          <section className="tbox-section">
            <div className="instances-heading"><div><p className="eyebrow">Classes and relationships</p><h2>Ontology classes</h2></div><span className="count">{classes.length}</span></div>
            <div className="tbox-class-sections">
              {classes.map((classIri) => <article className="tbox-class-section" key={classIri}>
                <header>
                  <div>
                    <h3>{localName(classIri)}</h3>
                    {triples.find((triple) => triple.subject === classIri
                      && triple.predicate === 'http://www.w3.org/2000/01/rdf-schema#comment')?.object
                      && <p className="tbox-class-comment">{triples.find((triple) => triple.subject === classIri
                        && triple.predicate === 'http://www.w3.org/2000/01/rdf-schema#comment')?.object}</p>}
                  </div>
                  <code>{classIri}</code>
                </header>
                <div className="tbox-property-groups">
                  <div className="tbox-group-stack">
                    <div><strong>Parent classes</strong>
                      {namedParentClassesOf(classIri).length ? namedParentClassesOf(classIri).map((item) => <code key={item}>{formatParentClass(item)}</code>) : <span className="tbox-muted">None</span>}
                    </div>
                    <div><strong>Subclasses</strong>
                      {subclassesOf(classIri).length ? subclassesOf(classIri).map((item) => <code key={item}>{localName(item)}</code>) : <span className="tbox-muted">None</span>}
                    </div>
                  </div>
                  <div><strong>Datatype properties</strong>
                    {outgoingProperties(classIri).filter((property) => property.kind === 'DatatypeProperty').length
                      ? outgoingProperties(classIri).filter((property) => property.kind === 'DatatypeProperty').map((property) => <span className="tbox-property datatype-property" key={property.iri}><code title={property.comment || 'No RDF comment available'}>{localName(property.iri)}</code> → {property.ranges.map(localName).join(', ') || 'literal'}</span>)
                      : <span className="tbox-muted">None</span>}
                  </div>
                  <div className="tbox-group-stack">
                    <div><strong className="object-properties-heading">Outgoing object properties</strong>
                      {outgoingProperties(classIri).filter((property) => property.kind === 'ObjectProperty').length
                        ? outgoingProperties(classIri).filter((property) => property.kind === 'ObjectProperty').map((property) => <span className="tbox-property object-property" key={property.iri}><code title={property.comment || 'No RDF comment available'}>{localName(property.iri)}</code> → {property.ranges.map(localName).join(', ') || 'resource'}</span>)
                        : <span className="tbox-muted">None</span>}
                    </div>
                    <div><strong className="object-properties-heading">Incoming object properties</strong>
                      {incomingProperties(classIri).length ? incomingProperties(classIri).flatMap((property) => (property.domains.length ? property.domains : ['']).map((domain) => (
                        <span className="tbox-property object-property" key={`${property.iri}|${domain}`}>
                          <code className="incoming-property-subject">{domain ? localName(domain) : 'Unknown class'}</code> → <code title={property.comment || 'No RDF comment available'}>{localName(property.iri)}</code>
                        </span>
                      ))) : <span className="tbox-muted">None</span>}
                    </div>
                  </div>
                  <div><strong className="restriction-heading">Class restrictions</strong>
                    {restrictionsOf(classIri).length ? restrictionsOf(classIri).map((item) => <code className="tbox-restriction" key={item}>{formatParentClass(item)}</code>) : <span className="tbox-muted">None</span>}
                  </div>
                </div>
              </article>)}
            </div>
          </section>
        </>}
      </section>
    </main>
  )
}
