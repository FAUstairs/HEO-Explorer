import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, RefreshCw, Search, XCircle } from 'lucide-react'
import TBox from './TBox'
import Diagram from './Diagram'

const QUERY_ENDPOINT = import.meta.env.VITE_QUERY_ENDPOINT ?? 'https://mathhub.info/api/backend/query'
const EXAMPLE_SPARQL_QUERY = `PREFIX heo: <https://mathhub.info/heo#>

SELECT DISTINCT ?personName ?moduleName WHERE {
  ?resource a heo:Module ;
            heo:coordinatedBy ?person ;
            heo:moduleName ?moduleName .
  ?person heo:hasFirstName ?firstName ;
          heo:hasLastName ?lastName .
  FILTER(CONTAINS(LCASE(STR(?moduleName)), "artificial intelligence"))
  BIND(CONCAT(STR(?firstName), " ", STR(?lastName)) AS ?personName)
}
ORDER BY LCASE(STR(?personName))`
const ONTOLOGY_QUERY = `
PREFIX heo: <https://mathhub.info/heo#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?class (SAMPLE(?classLabel) AS ?label) (SAMPLE(?classComment) AS ?comment) (COUNT(DISTINCT ?instance) AS ?instanceCount) WHERE {
  {
    SELECT DISTINCT ?class WHERE {
      { ?existingInstance a ?class . }
      UNION { ?class a owl:Class . }
      UNION { ?class rdfs:subClassOf ?parent . }
      UNION { ?child rdfs:subClassOf ?class . }
      FILTER(STRSTARTS(STR(?class), STR(heo:)))
    }
  }
  OPTIONAL { ?class rdfs:label ?classLabel . }
  OPTIONAL { ?class rdfs:comment ?classComment . }
  OPTIONAL { ?instance a ?class . }
}
GROUP BY ?class
ORDER BY LCASE(STR(?label))`

type Binding = { value?: string; type?: string }
type ResultRow = Record<string, Binding | string | null | undefined>

export type HeoClass = {
    iri: string
    notation: string
    localName: string
    instanceCount: number
    description?: string
}

type InstanceFilter = 'all' | 'with-instances' | 'without-instances'
type PropertyKind = 'datatype' | 'object'

type HeoProperty = {
    iri: string
    label: string
    kind: PropertyKind
    range: string
    originClass: string
    originLabel: string
}

type HeoInstance = {
    iri: string
    label: string
    classIri: string
    dataProperties: string[]
}

type InstanceProperty = {
    direction: 'outgoing' | 'incoming'
    subject: string
    subjectLabel: string
    predicate: string
    object: string
    objectLabel: string
    objectIsResource: boolean
}

function JsonValue({ name, value, depth = 0 }: { name?: string; value: unknown; depth?: number }) {
    const isObject = typeof value === 'object' && value !== null
    if (!isObject) {
        return <div className="json-entry"><span className="json-key">{name !== undefined ? `${name}: ` : ''}</span><span className={`json-value json-${typeof value}`}>{JSON.stringify(value)}</span></div>
    }

    const entries = Array.isArray(value)
        ? value.map((item, index) => [String(index), item] as const)
        : Object.entries(value as Record<string, unknown>)
    return (
        <details className="json-node" open>
            <summary><span className="json-key">{name ?? (Array.isArray(value) ? 'Array' : 'Object')}</span><span className="json-type">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span></summary>
            <div className="json-children">
                {entries.map(([key, child]) => <JsonValue key={key} name={Array.isArray(value) ? `[${key}]` : key} value={child} depth={depth + 1} />)}
            </div>
        </details>
    )
}

function valueOf(value: Binding | string | null | undefined): string {
    return typeof value === 'string' ? value : value?.value ?? ''
}

function isHeoIri(iri: string): boolean {
    return iri.startsWith('https://mathhub.info/heo#')
}

function localName(iri: string): string {
    return iri.split(/[/#]/).pop() || iri
}

function sparqlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`
}

function appUrl(view: 'classes' | 'class' | 'instance' | 'tbox' | 'instances' | 'diagram' | 'subclasses' | 'sparql', values: Record<string, string> = {}): string {
    const url = new URL(window.location.href)
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, '')
    url.pathname = `${basePath}${view === 'classes' ? '/' : `/${view}`}`
    url.search = ''
    Object.entries(values).forEach(([key, value]) => url.searchParams.set(key, value))
    return `${url.pathname}${url.search}`
}

function propertyQuery(classIri: string): string {
    return `
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT DISTINCT ?property ?propertyType ?label ?range ?originClass ?originLabel WHERE {
  <${classIri}> rdfs:subClassOf* ?originClass .
  ?property a ?propertyType ;
            rdfs:domain ?domain .
  VALUES ?propertyType { owl:DatatypeProperty owl:ObjectProperty }
  FILTER(?domain = ?originClass
    || EXISTS { ?domain owl:unionOf/rdf:rest*/rdf:first ?originClass . })
  OPTIONAL { ?property rdfs:label ?label . }
  OPTIONAL { ?property rdfs:range ?range . }
  OPTIONAL { ?originClass rdfs:label ?originLabel . }
}`
}

function classHierarchyQuery(classIri: string): string {
    return `
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?relation ?related WHERE {
  {
    BIND("parent" AS ?relation)
    <${classIri}> rdfs:subClassOf ?related .
    FILTER(isIRI(?related))
  }
  UNION {
    BIND("child" AS ?relation)
    ?related rdfs:subClassOf <${classIri}> .
    FILTER(isIRI(?related))
  }
}`
}

function instanceQuery(classIri: string, limit: number, offset: number, search: string): string {
    const searchTerms = search.trim().split(/\s+/).filter(Boolean)
    const searchFilter = searchTerms.map((term, index) => `FILTER EXISTS {
    ?instance ?searchProperty_${index} ?searchValue_${index} .
    FILTER(
      isLiteral(?searchValue_${index})
      && CONTAINS(
        LCASE(STR(?searchValue_${index})),
        LCASE(${sparqlString(term)})
      )
    )
  }`).join('\n')
    return `
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?instance (SAMPLE(?instanceLabel) AS ?label) ?dataProperty ?dataValue
WHERE {
  {
    SELECT DISTINCT ?instance WHERE {
      ?instance a <${classIri}> .
      ${searchFilter}
    }
    ORDER BY STR(?instance)
    LIMIT ${limit}
    OFFSET ${offset}
  }
  OPTIONAL { ?instance rdfs:label ?instanceLabel . }
  OPTIONAL {
    ?instance ?dataProperty ?dataValue .
    FILTER(isLiteral(?dataValue))
  }
}
GROUP BY ?instance ?dataProperty ?dataValue
ORDER BY STR(?instance)`
}

function allInstancesQuery(limit: number, offset: number, search: string): string {
    const searchTerms = search.trim().split(/\s+/).filter(Boolean)
    const searchFilter = searchTerms.map((term, index) => `FILTER EXISTS {
    ?instance ?searchProperty_${index} ?searchValue_${index} .
    FILTER(isLiteral(?searchValue_${index}) && CONTAINS(LCASE(STR(?searchValue_${index})), LCASE(${sparqlString(term)})))
  }`).join('\n')
    return `
PREFIX heo: <https://mathhub.info/heo#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?instance (SAMPLE(?instanceLabel) AS ?label) ?instanceClass ?dataProperty ?dataValue
WHERE {
  {
    SELECT DISTINCT ?instance ?instanceClass WHERE {
      ?instance a ?instanceClass .
      FILTER(STRSTARTS(STR(?instanceClass), STR(heo:)))
      ${searchFilter}
    }
    ORDER BY STR(?instance)
    LIMIT ${limit}
    OFFSET ${offset}
  }
  OPTIONAL { ?instance rdfs:label ?instanceLabel . }
  OPTIONAL {
    ?instance ?dataProperty ?dataValue .
    FILTER(isLiteral(?dataValue))
  }
}
GROUP BY ?instance ?instanceClass ?dataProperty ?dataValue
ORDER BY STR(?instance)`
}

function instancePropertyQuery(instanceIri: string): string {
    return `
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?direction ?subject ?subjectLabel ?predicate ?object ?objectLabel WHERE {
  {
    BIND("outgoing" AS ?direction)
    BIND(<${instanceIri}> AS ?subject)
    <${instanceIri}> ?predicate ?object .
    OPTIONAL { ?object rdfs:label ?objectLabel . }
  }
  UNION
  {
    BIND("incoming" AS ?direction)
    ?subject ?predicate <${instanceIri}> .
    BIND(<${instanceIri}> AS ?object)
    OPTIONAL { ?subject rdfs:label ?subjectLabel . }
  }
}
ORDER BY ?direction STR(?predicate) STR(?subject) STR(?object)`
}

function resourcePreviewQuery(instanceIri: string): string {
    return `
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?predicate ?object ?objectLabel WHERE {
  <${instanceIri}> ?predicate ?object .
  OPTIONAL { ?object rdfs:label ?objectLabel . }
}
ORDER BY STR(?predicate) STR(?object)
LIMIT 30`
}

function parseRows(payload: unknown): HeoClass[] {
    const rows = Array.isArray(payload)
        ? payload
        : (payload as { results?: { bindings?: ResultRow[] }; bindings?: ResultRow[] })?.results?.bindings
        ?? (payload as { bindings?: ResultRow[] })?.bindings
        ?? []

    const unique = new Map<string, HeoClass>()
    for (const row of rows as ResultRow[]) {
        const iri = valueOf(row.class)
        if (!iri || !isHeoIri(iri)) continue
        const notation = valueOf(row.label) || localName(iri)
        unique.set(iri, {
            iri,
            notation,
            localName: localName(iri),
            instanceCount: Number(valueOf(row.instanceCount)) || 0,
            description: valueOf(row.comment),
        })
    }
    return [...unique.values()].sort((a, b) => a.notation.localeCompare(b.notation, 'de'))
}

function parseProperties(payload: unknown): HeoProperty[] {
    const rows = Array.isArray(payload)
        ? payload
        : (payload as { results?: { bindings?: ResultRow[] }; bindings?: ResultRow[] })?.results?.bindings
        ?? (payload as { bindings?: ResultRow[] })?.bindings
        ?? []

    const unique = new Map<string, HeoProperty>()
    for (const row of rows as ResultRow[]) {
        const iri = valueOf(row.property)
        if (!iri) continue
        const type = valueOf(row.propertyType)
        const originClass = valueOf(row.originClass)
        unique.set(`${iri}|${originClass}`, {
            iri,
            label: valueOf(row.label) || localName(iri),
            kind: type.endsWith('DatatypeProperty') ? 'datatype' : 'object',
            range: valueOf(row.range),
            originClass,
            originLabel: valueOf(row.originLabel) || localName(originClass),
        })
    }
    return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label, 'en'))
}

function parseInstances(payload: unknown): HeoInstance[] {
    const rows = Array.isArray(payload)
        ? payload
        : (payload as { results?: { bindings?: ResultRow[] }; bindings?: ResultRow[] })?.results?.bindings
        ?? (payload as { bindings?: ResultRow[] })?.bindings
        ?? []

    const instances = new Map<string, HeoInstance>()
    for (const row of rows as ResultRow[]) {
        const iri = valueOf(row.instance)
        if (!iri) continue
        const instance = instances.get(iri) ?? {
            iri,
            label: valueOf(row.label) || localName(iri),
            classIri: valueOf(row.instanceClass),
            dataProperties: [],
        }
        if (!instance.classIri) instance.classIri = valueOf(row.instanceClass)
        const predicate = localName(valueOf(row.dataProperty))
        const value = valueOf(row.dataValue)
        const dataProperty = predicate && value ? `${predicate}:${value}` : ''
        if (dataProperty && !instance.dataProperties.includes(dataProperty)) instance.dataProperties.push(dataProperty)
        instances.set(iri, instance)
    }
    return [...instances.values()].map((instance) => ({
        ...instance,
        dataProperties: instance.dataProperties.sort((a, b) => {
            const [propertyA, valueA = ''] = a.split(':')
            const [propertyB, valueB = ''] = b.split(':')
            return propertyA.localeCompare(propertyB, 'en', { sensitivity: 'base' })
                || valueA.localeCompare(valueB, 'en', { sensitivity: 'base', numeric: true })
        }),
    }))
}

function parseInstanceProperties(payload: unknown): InstanceProperty[] {
    const rows = Array.isArray(payload)
        ? payload
        : (payload as { results?: { bindings?: ResultRow[] }; bindings?: ResultRow[] })?.results?.bindings
        ?? (payload as { bindings?: ResultRow[] })?.bindings
        ?? []

    return (rows as ResultRow[]).map((row) => {
        const direction = valueOf(row.direction) === 'incoming' ? 'incoming' : 'outgoing'
        const object = row.object
        return {
            direction,
            subject: valueOf(row.subject),
            subjectLabel: valueOf(row.subjectLabel),
            predicate: valueOf(row.predicate),
            object: valueOf(object),
            objectLabel: valueOf(row.objectLabel),
            objectIsResource: typeof object !== 'string' && object?.type === 'uri',
        } satisfies InstanceProperty
    }).filter((property) => property.predicate && property.object)
}

type ResourcePreviewProperty = {
    predicate: string
    object: string
    objectLabel: string
    objectIsResource: boolean
}

function parseResourcePreview(payload: unknown): ResourcePreviewProperty[] {
    const rows = Array.isArray(payload)
        ? payload
        : (payload as { results?: { bindings?: ResultRow[] }; bindings?: ResultRow[] })?.results?.bindings
        ?? (payload as { bindings?: ResultRow[] })?.bindings
        ?? []

    return (rows as ResultRow[]).map((row) => {
        const object = row.object
        return {
            predicate: valueOf(row.predicate),
            object: valueOf(object),
            objectLabel: valueOf(row.objectLabel),
            objectIsResource: typeof object !== 'string' && object?.type === 'uri',
        }
    }).filter((property) => property.predicate && property.object)
}

function App() {
    const [classes, setClasses] = useState<HeoClass[]>([])
    const [search, setSearch] = useState('')
    const [instanceFilter, setInstanceFilter] = useState<InstanceFilter>('all')
    const [selectedClass, setSelectedClass] = useState<HeoClass | null>(null)
    const [properties, setProperties] = useState<HeoProperty[]>([])
    const [classParents, setClassParents] = useState<string[]>([])
    const [classChildren, setClassChildren] = useState<string[]>([])
    const [propertiesLoading, setPropertiesLoading] = useState(false)
    const [propertiesError, setPropertiesError] = useState<string | null>(null)
    const [instances, setInstances] = useState<HeoInstance[]>([])
    const [instancesLoading, setInstancesLoading] = useState(false)
    const [instancesError, setInstancesError] = useState<string | null>(null)
    const [instancePage, setInstancePage] = useState(0)
    const [instancePageSize, setInstancePageSize] = useState(10)
    const [instanceSearch, setInstanceSearch] = useState('')
    const [globalInstanceSearch, setGlobalInstanceSearch] = useState('')
    const [globalInstances, setGlobalInstances] = useState<HeoInstance[]>([])
    const [globalInstancePage, setGlobalInstancePage] = useState(0)
    const [globalInstancePageSize, setGlobalInstancePageSize] = useState(10)
    const [globalInstancesLoading, setGlobalInstancesLoading] = useState(false)
    const [globalInstancesError, setGlobalInstancesError] = useState<string | null>(null)
    const [showGlobalInstances, setShowGlobalInstances] = useState(false)
    const [showTBox, setShowTBox] = useState(false)
    const [showDiagram, setShowDiagram] = useState(false)
    const [showSparql, setShowSparql] = useState(false)
    const [sparqlQuery, setSparqlQuery] = useState(EXAMPLE_SPARQL_QUERY)
    const [sparqlResult, setSparqlResult] = useState<unknown>(null)
    const [sparqlLoading, setSparqlLoading] = useState(false)
    const [sparqlError, setSparqlError] = useState<string | null>(null)
    const [diagramMode, setDiagramMode] = useState<'properties' | 'subclasses'>('properties')
    const instanceSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const instanceRequestId = useRef(0)
    const globalInstanceSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const globalInstanceRequestId = useRef(0)
    const [selectedInstance, setSelectedInstance] = useState<HeoInstance | null>(null)
    const [instanceHistory, setInstanceHistory] = useState<HeoInstance[]>([])
    const [instanceProperties, setInstanceProperties] = useState<InstanceProperty[]>([])
    const [instancePropertiesLoading, setInstancePropertiesLoading] = useState(false)
    const [instancePropertiesError, setInstancePropertiesError] = useState<string | null>(null)
    const [enabledProperties, setEnabledProperties] = useState<Set<string>>(new Set())
    const [hoveredResource, setHoveredResource] = useState<{ iri: string; label: string } | null>(null)
    const [resourcePreview, setResourcePreview] = useState<ResourcePreviewProperty[]>([])
    const [resourcePreviewLoading, setResourcePreviewLoading] = useState(false)
    const [resourcePreviewError, setResourcePreviewError] = useState<string | null>(null)
    const resourcePreviewRequestId = useRef(0)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
    // const [token, setToken] = useState(() => localStorage.getItem('heo-admin-token'))
    const [token, setToken] = useState(() => "ABC")
    const [loginError, setLoginError] = useState<string | null>(null)
    const [loggingIn, setLoggingIn] = useState(false)
    const restoredUrl = useRef(false)

    const navigateTo = useCallback((view: 'classes' | 'class' | 'instance' | 'tbox' | 'instances' | 'diagram' | 'subclasses' | 'sparql', values: Record<string, string> = {}) => {
        window.history.pushState({}, '', appUrl(view, values))
    }, [])

    async function login(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setLoggingIn(true)
        setLoginError(null)
        const form = new FormData(event.currentTarget)
        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
            })
            const data = await response.json() as { token?: string; error?: string }
            if (!response.ok || !data.token) throw new Error(data.error ?? 'Login failed.')
            localStorage.setItem('heo-admin-token', data.token)
            setToken(data.token)
        } catch (cause) {
            setLoginError(cause instanceof Error ? cause.message : 'Login failed.')
        } finally {
            setLoggingIn(false)
        }
    }

    const loadClasses = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const response = await fetch(QUERY_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ query: ONTOLOGY_QUERY }),
            })
            if (!response.ok) throw new Error(`Der Ontologie-Service antwortet mit HTTP ${response.status}.`)
            setClasses(parseRows(await response.json()))
            setLastUpdated(new Date())
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The classes could not be loaded.')
        } finally {
            setLoading(false)
        }
    }, [])

    const showProperties = useCallback(async (item: HeoClass, updateUrl = true) => {
        if (updateUrl) navigateTo('class', { iri: item.iri })
        setSelectedClass(item)
        setProperties([])
        setClassParents([])
        setClassChildren([])
        setPropertiesError(null)
        setInstances([])
        setInstancesError(null)
        setInstancePage(0)
        setInstanceSearch('')
        setPropertiesLoading(true)
        setInstancesLoading(true)
        try {
            const [propertyResponse, instanceResponse, hierarchyResponse] = await Promise.all([
                fetch(QUERY_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: new URLSearchParams({ query: propertyQuery(item.iri) }),
                }),
                fetch(QUERY_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: new URLSearchParams({ query: instanceQuery(item.iri, instancePageSize, 0, '') }),
                }),
                fetch(QUERY_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: new URLSearchParams({ query: classHierarchyQuery(item.iri) }),
                }),
            ])
            if (!propertyResponse.ok) throw new Error(`The ontology service returned HTTP ${propertyResponse.status}.`)
            if (!instanceResponse.ok) throw new Error(`The ontology service returned HTTP ${instanceResponse.status}.`)
            if (!hierarchyResponse.ok) throw new Error(`The ontology service returned HTTP ${hierarchyResponse.status}.`)
            setProperties(parseProperties(await propertyResponse.json()))
            setInstances(parseInstances(await instanceResponse.json()))
            const hierarchyPayload = await hierarchyResponse.json() as { results?: { bindings?: ResultRow[] } }
            const hierarchyRows = hierarchyPayload.results?.bindings ?? []
            setClassParents([...new Set(hierarchyRows.filter((row) => valueOf(row.relation) === 'parent').map((row) => valueOf(row.related)))])
            setClassChildren([...new Set(hierarchyRows.filter((row) => valueOf(row.relation) === 'child').map((row) => valueOf(row.related)))])
        } catch (cause) {
            setPropertiesError(cause instanceof Error ? cause.message : 'The properties could not be loaded.')
        } finally {
            setPropertiesLoading(false)
            setInstancesLoading(false)
        }
    }, [instancePageSize, navigateTo])

    const openClassResource = useCallback((classIri: string) => {
        const classFromList = classes.find((item) => item.iri === classIri)
        const classForView = classFromList ?? {
            iri: classIri,
            notation: localName(classIri),
            localName: localName(classIri),
            instanceCount: 0,
        }
        setSelectedInstance(null)
        setInstanceHistory([])
        void showProperties(classForView)
    }, [classes, showProperties])

    const loadInstances = useCallback(async (classIri: string, page: number, pageSize: number, search = instanceSearch) => {
        const requestId = ++instanceRequestId.current
        setInstancesLoading(true)
        setInstancesError(null)
        try {
            const response = await fetch(QUERY_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ query: instanceQuery(classIri, pageSize, page * pageSize, search) }),
            })
            if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
            const nextInstances = parseInstances(await response.json())
            if (requestId === instanceRequestId.current) setInstances(nextInstances)
        } catch (cause) {
            if (requestId === instanceRequestId.current) {
                setInstancesError(cause instanceof Error ? cause.message : 'The instances could not be loaded.')
            }
        } finally {
            if (requestId === instanceRequestId.current) setInstancesLoading(false)
        }
    }, [instanceSearch])

    const loadGlobalInstances = useCallback(async (page: number, pageSize: number, search = globalInstanceSearch) => {
        const requestId = ++globalInstanceRequestId.current
        setGlobalInstancesLoading(true)
        setGlobalInstancesError(null)
        try {
            const response = await fetch(QUERY_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ query: allInstancesQuery(pageSize, page * pageSize, search) }),
            })
            if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
            const nextInstances = parseInstances(await response.json())
            if (requestId === globalInstanceRequestId.current) setGlobalInstances(nextInstances)
        } catch (cause) {
            if (requestId === globalInstanceRequestId.current) {
                setGlobalInstancesError(cause instanceof Error ? cause.message : 'The instances could not be loaded.')
            }
        } finally {
            if (requestId === globalInstanceRequestId.current) setGlobalInstancesLoading(false)
        }
    }, [globalInstanceSearch])

    const loadInstanceProperties = useCallback(async (instance: HeoInstance) => {
        setInstancePropertiesLoading(true)
        setInstancePropertiesError(null)
        try {
            const response = await fetch(QUERY_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ query: instancePropertyQuery(instance.iri) }),
            })
            if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
            const nextProperties = parseInstanceProperties(await response.json())
            setInstanceProperties(nextProperties)
            setEnabledProperties((current) => {
                const available = new Set(nextProperties.map((property) => property.predicate))
                const retained = new Set([...current].filter((predicate) => available.has(predicate)))
                nextProperties.forEach((property) => {
                    if (!current.size || property.predicate.startsWith('https://mathhub.info/heo#')) retained.add(property.predicate)
                })
                return retained
            })
        } catch (cause) {
            setInstancePropertiesError(cause instanceof Error ? cause.message : 'The instance data could not be loaded.')
        } finally {
            setInstancePropertiesLoading(false)
        }
    }, [])

    const loadResourcePreview = useCallback(async (resource: { iri: string; label: string }) => {
        const requestId = ++resourcePreviewRequestId.current
        setHoveredResource(resource)
        setResourcePreview([])
        setResourcePreviewError(null)
        setResourcePreviewLoading(true)
        try {
            const response = await fetch(QUERY_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ query: resourcePreviewQuery(resource.iri) }),
            })
            if (!response.ok) throw new Error(`The ontology service returned HTTP ${response.status}.`)
            const nextPreview = parseResourcePreview(await response.json())
            if (requestId === resourcePreviewRequestId.current) setResourcePreview(nextPreview)
        } catch (cause) {
            if (requestId === resourcePreviewRequestId.current) {
                setResourcePreviewError(cause instanceof Error ? cause.message : 'The resource preview could not be loaded.')
            }
        } finally {
            if (requestId === resourcePreviewRequestId.current) setResourcePreviewLoading(false)
        }
    }, [])

    const clearResourcePreview = useCallback(() => {
        resourcePreviewRequestId.current += 1
        setHoveredResource(null)
        setResourcePreview([])
        setResourcePreviewError(null)
        setResourcePreviewLoading(false)
    }, [])

    const openInstance = useCallback((instance: HeoInstance) => {
        if (selectedInstance) setInstanceHistory((history) => [...history, selectedInstance])
        navigateTo('instance', {
            class: selectedClass?.iri ?? instance.classIri,
            iri: instance.iri,
        })
        setSelectedInstance(instance)
        void loadInstanceProperties(instance)
    }, [loadInstanceProperties, navigateTo, selectedClass?.iri, selectedInstance])

    const goBackFromInstance = useCallback(() => {
        const previous = instanceHistory[instanceHistory.length - 1]
        if (previous) {
            setInstanceHistory((history) => history.slice(0, -1))
            setSelectedInstance(previous)
            void loadInstanceProperties(previous)
        } else {
            setSelectedInstance(null)
            navigateTo(selectedClass ? 'class' : 'classes', selectedClass ? { iri: selectedClass.iri } : {})
        }
    }, [instanceHistory, loadInstanceProperties, navigateTo, selectedClass])

    const openGlobalInstance = useCallback((instance: HeoInstance) => {
        const classFromList = classes.find((item) => item.iri === instance.classIri)
        const classForInstance = classFromList ?? {
            iri: instance.classIri,
            notation: localName(instance.classIri),
            localName: localName(instance.classIri),
            instanceCount: 0,
        }
        setShowGlobalInstances(false)
        setSelectedClass(classForInstance)
        openInstance(instance)
    }, [classes, openInstance])

    useEffect(() => {
        if (token) void loadClasses()
    }, [loadClasses, token])

    useEffect(() => {
        const restoreFromUrl = () => {
            const url = new URL(window.location.href)
            const basePath = import.meta.env.BASE_URL.replace(/\/$/, '')
            const routePath = url.pathname.startsWith(`${basePath}/`)
                ? url.pathname.slice(basePath.length)
                : url.pathname
            const classIri = routePath === '/instance'
                ? url.searchParams.get('class')
                : url.searchParams.get('iri')
            const instanceIri = url.searchParams.get('instance') || (routePath === '/instance' ? url.searchParams.get('iri') : null)

            if (routePath === '/tbox') {
                setShowTBox(true)
                setShowDiagram(false)
                setShowSparql(false)
                setShowGlobalInstances(false)
                return
            }
            if (routePath === '/sparql') {
                setShowTBox(false)
                setShowDiagram(false)
                setShowSparql(true)
                setShowGlobalInstances(false)
                return
            }
            if (routePath === '/diagram') {
                setShowTBox(false)
                setShowDiagram(true)
                setShowSparql(false)
                setDiagramMode('properties')
                setShowGlobalInstances(false)
                return
            }
            if (routePath === '/subclasses') {
                setShowTBox(false)
                setShowDiagram(true)
                setShowSparql(false)
                setDiagramMode('subclasses')
                setShowGlobalInstances(false)
                return
            }
            if (routePath === '/instances') {
                setShowTBox(false)
                setShowDiagram(false)
                setShowSparql(false)
                setShowGlobalInstances(true)
                setGlobalInstancePage(0)
                void loadGlobalInstances(0, globalInstancePageSize, globalInstanceSearch)
                return
            }
            if (routePath !== '/class' && routePath !== '/instance') {
                setShowTBox(false)
                setShowDiagram(false)
                setShowSparql(false)
                setShowGlobalInstances(false)
                setSelectedClass(null)
                setSelectedInstance(null)
                return
            }
            if (!classIri || classes.length === 0) return

            const classForView = classes.find((item) => item.iri === classIri) ?? {
                iri: classIri,
                notation: localName(classIri),
                localName: localName(classIri),
                instanceCount: 0,
            }
            setShowTBox(false)
            setShowDiagram(false)
            setShowGlobalInstances(false)
            void showProperties(classForView, false).then(() => {
                if (routePath !== '/instance' || !instanceIri) return
                const instance: HeoInstance = {
                    iri: instanceIri,
                    label: localName(instanceIri),
                    classIri: classForView.iri,
                    dataProperties: [],
                }
                setSelectedInstance(instance)
                void loadInstanceProperties(instance)
            })
        }

        if (!restoredUrl.current && classes.length > 0) {
            restoredUrl.current = true
            restoreFromUrl()
        }

        window.addEventListener('popstate', restoreFromUrl)
        return () => window.removeEventListener('popstate', restoreFromUrl)
    }, [classes, globalInstancePageSize, globalInstanceSearch, loadGlobalInstances, loadInstanceProperties, showProperties])

    const filteredClasses = useMemo(() => {
        const normalized = search.trim().toLocaleLowerCase('de')
        return classes.filter(({ iri, notation, localName: name, instanceCount }) => {
            const matchesSearch = !normalized
                || [iri, notation, name].some((value) => value.toLocaleLowerCase('de').includes(normalized))
            const matchesInstanceFilter = instanceFilter === 'all'
                || (instanceFilter === 'with-instances' && instanceCount > 0)
                || (instanceFilter === 'without-instances' && instanceCount === 0)
            return matchesSearch && matchesInstanceFilter
        })
    }, [classes, instanceFilter, search])
    const totalClasses = classes.length
    const classesWithInstances = classes.filter((item) => item.instanceCount > 0).length

    if (!token) {
        return <main className="login-page"><form className="login-card" onSubmit={login}>
            <div className="brand"><span className="brand-mark">H</span><span>HEO <strong>Explorer</strong></span></div>
            <p className="eyebrow">Admin access</p><h1>Sign in</h1>
            <label>Username<input name="username" defaultValue="admin" autoComplete="username" required /></label>
            <label>Password<input name="password" type="password" defaultValue="admin" autoComplete="current-password" required /></label>
            {loginError && <p className="login-error">{loginError}</p>}
            <button type="submit" disabled={loggingIn}>{loggingIn ? 'Signing in …' : 'Sign in'}</button>
        </form></main>
    }

    async function executeSparql(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setSparqlLoading(true)
        setSparqlError(null)
        setSparqlResult(null)
        try {
            const query = sparqlQuery.trim()
            if (!query) throw new Error('Please enter a SPARQL query.')
            const response = await fetch(QUERY_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ query }),
            })
            if (!response.ok) throw new Error(`The SPARQL endpoint responded with HTTP ${response.status}.`)
            setSparqlResult(await response.json())
        } catch (cause) {
            setSparqlError(cause instanceof Error ? cause.message : 'The SPARQL query could not be executed.')
        } finally {
            setSparqlLoading(false)
        }
    }

    if (showSparql) {
        return (
            <main className="shell">
                <header className="topbar">
                    <div className="brand"><span className="brand-mark">H</span><span>HEO <strong>Explorer</strong></span></div>
                    <button className="refresh-button" onClick={() => { setShowSparql(false); navigateTo('classes') }}><ArrowLeft size={16} /> Back to classes</button>
                </header>
                <section className="property-page sparql-page">
                    <button className="back-link" onClick={() => { setShowSparql(false); navigateTo('classes') }}><ArrowLeft size={16} /> Back to all classes</button>
                    <p className="eyebrow">Query console</p>
                    <h1>SPARQL</h1>
                    <p className="intro">Run read-only queries against the HEO triple store and inspect the JSON response.</p>
                    <form className="sparql-form" onSubmit={executeSparql}>
                        <label htmlFor="sparql-query">Query</label>
                        <textarea id="sparql-query" value={sparqlQuery} onChange={(event) => setSparqlQuery(event.target.value)} spellCheck={false} rows={14} />
                        <button className="refresh-button sparql-run-button" type="submit" disabled={sparqlLoading}>
                            {sparqlLoading ? <LoaderCircle className="spin" size={16} /> : null}
                            {sparqlLoading ? 'Running …' : 'Run query'}
                        </button>
                    </form>
                    {sparqlError && <div className="notice error"><AlertCircle size={20} /><div><strong>Query failed</strong><p>{sparqlError}</p></div></div>}
                    {sparqlResult !== null && <section className="sparql-results">
                        <div className="instances-heading"><div><p className="eyebrow">Response</p><h2>JSON result</h2></div></div>
                        <div className="json-viewer"><JsonValue value={sparqlResult} /></div>
                    </section>}
                </section>
            </main>
        )
    }

    if (showTBox) {
        return <TBox onBack={() => { setShowTBox(false); navigateTo('classes') }} />
    }

    if (showDiagram) {
        return <Diagram
            endpoint={QUERY_ENDPOINT}
            classes={classes}
            mode={diagramMode}
            onBack={() => { setShowDiagram(false); navigateTo('classes') }}
            onChangeMode={(mode) => {
                setDiagramMode(mode)
                navigateTo(mode === 'subclasses' ? 'subclasses' : 'diagram')
            }}
            onOpenClass={(classIri) => {
                setShowDiagram(false)
                openClassResource(classIri)
            }}
        />
    }

    if (showGlobalInstances) {
        return (
            <main className="shell">
                <header className="topbar">
                    <div className="brand"><span className="brand-mark">H</span><span>HEO <strong>Explorer</strong></span></div>
                    <button className="refresh-button" onClick={() => { setShowGlobalInstances(false); navigateTo('classes') }}><ArrowLeft size={16} /> Back to classes</button>
                </header>
                <section className="property-page">
                    <button className="back-link" onClick={() => { setShowGlobalInstances(false); navigateTo('classes') }}><ArrowLeft size={16} /> Back to all classes</button>
                    <p className="eyebrow">ABox explorer</p>
                    <h1>All instances</h1>
                    <p className="intro">Search data property values across all HEO classes.</p>
                    <div className="instance-search global-instance-search">
                        <Search size={16} />
                        <input
                            value={globalInstanceSearch}
                            onChange={(event) => {
                                const searchValue = event.target.value
                                setGlobalInstanceSearch(searchValue)
                                setGlobalInstancePage(0)
                                if (globalInstanceSearchTimer.current) clearTimeout(globalInstanceSearchTimer.current)
                                globalInstanceSearchTimer.current = setTimeout(() => {
                                    void loadGlobalInstances(0, globalInstancePageSize, searchValue)
                                }, 300)
                            }}
                            placeholder="Search all instance values …"
                            aria-label="Search all instance values"
                        />
                        {globalInstanceSearch && <button onClick={() => {
                            setGlobalInstanceSearch('')
                            setGlobalInstancePage(0)
                            void loadGlobalInstances(0, globalInstancePageSize, '')
                        }} aria-label="Clear global instance search">×</button>}
                    </div>
                    <div className="instances-heading">
                        <div><p className="eyebrow">Results</p><h2>HEO instances</h2></div>
                        <label>Per page
                            <select value={globalInstancePageSize} onChange={(event) => {
                                const size = Number(event.target.value)
                                setGlobalInstancePageSize(size)
                                setGlobalInstancePage(0)
                                void loadGlobalInstances(0, size)
                            }}>
                                {[10, 25, 50, 75, 100].map((size) => <option key={size} value={size}>{size}</option>)}
                            </select>
                        </label>
                    </div>
                    {globalInstancesError && <div className="notice error"><AlertCircle size={20} /><div><strong>Loading failed</strong><p>{globalInstancesError}</p></div><button onClick={() => void loadGlobalInstances(globalInstancePage, globalInstancePageSize)}>Try again</button></div>}
                    {globalInstancesLoading && <div className="loading"><LoaderCircle className="spin" size={28} /><span>Loading instances …</span></div>}
                    {!globalInstancesLoading && !globalInstancesError && globalInstances.length === 0 && <div className="instance-empty"><strong>{globalInstanceSearch ? `No instances match “${globalInstanceSearch}”.` : 'No instances found.'}</strong><span>Try different search words.</span></div>}
                    {!globalInstancesLoading && !globalInstancesError && globalInstances.length > 0 && <div className="instance-list">
                        {globalInstances.map((instance) => <button className="instance-row" key={instance.iri} onClick={() => openGlobalInstance(instance)}>
                            <span className="instance-identity">
                                {instance.label !== localName(instance.iri) && <strong>{instance.label}</strong>}
                                <code title={instance.iri}>{instance.iri}</code>
                                <span className="instance-data-properties">
                                    {instance.classIri && <span className="instance-class-tag">Class: {localName(instance.classIri)}</span>}
                                    {instance.dataProperties.map((property) => <span className="instance-data-value" key={property}>{property}</span>)}
                                </span>
                            </span>
                            <ExternalLink size={14} />
                        </button>)}
                    </div>}
                    {(globalInstancePage > 0 || globalInstances.length === globalInstancePageSize) && <div className="pagination">
                        <button disabled={globalInstancePage === 0 || globalInstancesLoading} onClick={() => { const page = globalInstancePage - 1; setGlobalInstancePage(page); void loadGlobalInstances(page, globalInstancePageSize) }}><ChevronLeft size={15} /> Previous</button>
                        <span>Page {globalInstancePage + 1}{globalInstanceSearch ? '' : ''}</span>
                        <button disabled={globalInstances.length < globalInstancePageSize || globalInstancesLoading} onClick={() => { const page = globalInstancePage + 1; setGlobalInstancePage(page); void loadGlobalInstances(page, globalInstancePageSize) }}>Next <ChevronRight size={15} /></button>
                    </div>}
                </section>
            </main>
        )
    }

    if (selectedClass && selectedInstance) {
        const visibleProperties = instanceProperties.filter((property) => enabledProperties.has(property.predicate))
        const propertyName = (iri: string) => properties.find((property) => property.iri === iri)?.label || localName(iri)
        const incomingPredicates = new Set(
            instanceProperties
                .filter((property) => property.direction === 'incoming')
                .map((property) => property.predicate),
        )
        return (
            <main className="shell">
                <header className="topbar">
                    <div className="brand"><span className="brand-mark">H</span><span>HEO <strong>Explorer</strong></span></div>
                    <button className="refresh-button" onClick={goBackFromInstance}><ArrowLeft size={16} /> Back</button>
                </header>
                <section className="property-page">
                    <button className="back-link" onClick={goBackFromInstance}><ArrowLeft size={16} /> Back to {instanceHistory.length ? 'previous instance' : selectedClass.notation}</button>
                    <p className="eyebrow">ABox instance</p>
                    <h1>{selectedInstance.label}</h1>
                    <p className="property-page-iri">{selectedInstance.iri}</p>
                    <div className="instance-filter-panel">
                        <div><p className="eyebrow">Predicate filters</p><h2>Displayed properties</h2></div>
                        <div className="predicate-toggles">
                            {[...new Set([...properties.map((property) => property.iri), ...instanceProperties.map((property) => property.predicate)])].map((predicate) => (
                                <button key={predicate} className={[
                                    'predicate-toggle',
                                    incomingPredicates.has(predicate) ? 'incoming' : '',
                                    enabledProperties.has(predicate) ? 'active' : '',
                                ].filter(Boolean).join(' ')} onClick={() => setEnabledProperties((current) => {
                                    const next = new Set(current)
                                    if (next.has(predicate)) next.delete(predicate); else next.add(predicate)
                                    return next
                                })}>{propertyName(predicate)}</button>
                            ))}
                        </div>
                    </div>
                    {instancePropertiesError && <div className="notice error"><AlertCircle size={20} /><div><strong>Loading failed</strong><p>{instancePropertiesError}</p></div><button onClick={() => void loadInstanceProperties(selectedInstance)}>Try again</button></div>}
                    {instancePropertiesLoading && <div className="loading"><LoaderCircle className="spin" size={28} /><span>Loading instance data …</span></div>}
                    {!instancePropertiesLoading && !instancePropertiesError && visibleProperties.length === 0 && <div className="empty"><Search size={30} /><strong>No properties selected</strong><span>Enable a predicate above to display its value.</span></div>}
                    {!instancePropertiesLoading && !instancePropertiesError && visibleProperties.length > 0 && <div className="instance-data-list">
                        {visibleProperties.map((property) => {
                            const relatedResource = property.direction === 'incoming' ? property.subject : property.object
                            const relatedLabel = property.direction === 'incoming'
                                ? property.subjectLabel || localName(property.subject)
                                : property.objectLabel || localName(property.object)
                            const relatedIsResource = property.direction === 'incoming' || property.objectIsResource
                            const showResourcePreview = relatedIsResource
                            return (
                                <div className={`instance-data-row ${property.direction}`} key={`${property.direction}|${property.subject}|${property.predicate}|${property.object}`}>
                                    <span className="instance-predicate">{propertyName(property.predicate)}</span>
                                    {relatedIsResource
                                ? <span
                                    className="resource-preview-anchor"
                                    onMouseEnter={showResourcePreview ? () => void loadResourcePreview({ iri: relatedResource, label: relatedLabel }) : undefined}
                                    onMouseLeave={showResourcePreview ? clearResourcePreview : undefined}
                                >
                                    <button className="resource-link" onClick={() => {
                                        if (property.direction === 'outgoing'
                                            && property.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
                                            && isHeoIri(property.object)) {
                                            openClassResource(property.object)
                                        } else {
                                            openInstance({
                                                iri: relatedResource,
                                                label: relatedLabel,
                                                classIri: '',
                                                dataProperties: [],
                                            })
                                        }
                                    }}>{relatedLabel} <ExternalLink size={13} /></button>
                                    {showResourcePreview && hoveredResource?.iri === relatedResource && <div className="resource-preview" role="status">
                                        <strong>{hoveredResource.label}</strong>
                                        <code title={hoveredResource.iri}>{hoveredResource.iri}</code>
                                        {resourcePreviewLoading && <span className="resource-preview-status">Loading …</span>}
                                        {resourcePreviewError && <span className="resource-preview-error">{resourcePreviewError}</span>}
                                        {!resourcePreviewLoading && !resourcePreviewError && resourcePreview.length === 0 && <span className="resource-preview-status">No outgoing properties.</span>}
                                        {!resourcePreviewLoading && !resourcePreviewError && resourcePreview.length > 0 && <div className="resource-preview-list">
                                            {resourcePreview.map((previewProperty, index) => {
                                                const previewValue = previewProperty.objectLabel || (previewProperty.objectIsResource ? localName(previewProperty.object) : previewProperty.object)
                                                return <div className="resource-preview-row" key={`${previewProperty.predicate}|${previewProperty.object}|${index}`}>
                                                    <span>{propertyName(previewProperty.predicate)}</span>
                                                    <strong title={previewProperty.object}>{previewValue}</strong>
                                                </div>
                                            })}
                                        </div>}
                                    </div>}
                                </span>
                                : <span className="literal-value">{property.object}</span>}
                                    <code title={property.predicate}>{property.predicate}</code>
                                </div>
                            )
                        })}
                    </div>}
                </section>
                <footer>{lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString('en-GB')}` : 'Connecting to the triple store …'}</footer>
            </main>
        )
    }

    if (selectedClass) {
        return (
            <main className="shell">
                <header className="topbar">
                    <div className="brand"><span className="brand-mark">H</span><span>HEO <strong>Explorer</strong></span></div>
                    <button className="refresh-button" onClick={() => { setSelectedClass(null); navigateTo('classes') }}>
                        <ArrowLeft size={16} /> Back to classes
                    </button>
                </header>
                <section className="property-page">
                    <button className="back-link" onClick={() => { setSelectedClass(null); navigateTo('classes') }}>
                        <ArrowLeft size={16} /> Back to all classes
                    </button>
                    <p className="eyebrow">TBox properties</p>
                    <h1>{selectedClass.notation}</h1>
                    <p className="property-page-iri">{selectedClass.iri}</p>
                    {selectedClass.description && <p className="property-page-description">{selectedClass.description}</p>}
                    {(classParents.length > 0 || classChildren.length > 0) && <div className="class-hierarchy-summary">
                        {classParents.length > 0 && <div><strong>Parent classes</strong><span>{classParents.map(localName).join(', ')}</span></div>}
                        {classChildren.length > 0 && <div><strong>Subclasses</strong><span>{classChildren.map(localName).join(', ')}</span></div>}
                    </div>}
                    <div className="property-summary">
                        <span>{selectedClass.instanceCount.toLocaleString('en-GB')} instances</span>
                        <span>{properties.length} properties</span>
                    </div>
                    <section className="instances-section" aria-label="Class instances">
                        <div className="instances-heading">
                            <div><p className="eyebrow">ABox instances</p><h2>Instances</h2></div>
                            <label>Per page
                                <select value={instancePageSize} onChange={(event) => {
                                    const nextSize = Number(event.target.value)
                                    setInstancePageSize(nextSize)
                                    setInstancePage(0)
                                    void loadInstances(selectedClass.iri, 0, nextSize)
                                }}>
                                    {[10, 25, 50, 75, 100].map((size) => <option key={size} value={size}>{size}</option>)}
                                </select>
                            </label>
                        </div>
                        <div className="instance-search">
                            <Search size={16} />
                            <input
                                value={instanceSearch}
                                onChange={(event) => {
                                    const search = event.target.value
                                    setInstanceSearch(search)
                                    setInstancePage(0)
                                    if (instanceSearchTimer.current) clearTimeout(instanceSearchTimer.current)
                                    instanceSearchTimer.current = setTimeout(() => {
                                        void loadInstances(selectedClass.iri, 0, instancePageSize, search)
                                    }, 300)
                                }}
                                placeholder="Search values (all words must match) …"
                                aria-label="Search data property values"
                            />
                            {instanceSearch && <button onClick={() => {
                                setInstanceSearch('')
                                setInstancePage(0)
                                void loadInstances(selectedClass.iri, 0, instancePageSize, '')
                            }} aria-label="Clear instance search">×</button>}
                        </div>
                        {instancesError && <div className="notice error"><AlertCircle size={20} /><div><strong>Loading instances failed</strong><p>{instancesError}</p></div><button onClick={() => void loadInstances(selectedClass.iri, instancePage, instancePageSize)}>Try again</button></div>}
                        {instancesLoading && <div className="loading"><LoaderCircle className="spin" size={24} /><span>Loading instances …</span></div>}
                        {!instancesLoading && !instancesError && instances.length === 0 && <div className="instance-empty">
                            <strong>{instanceSearch ? `No instances match “${instanceSearch}”.` : 'No instances found for this class.'}</strong>
                            <span>{instanceSearch ? 'Try different search words.' : 'This class currently has no instances.'}</span>
                        </div>}
                        {!instancesLoading && !instancesError && instances.length > 0 && <div className="instance-list">
                            {instances.map((instance) => <button className="instance-row" key={instance.iri} onClick={() => openInstance(instance)}>
                                <span className="instance-identity">
                                    {instance.label !== localName(instance.iri) && <strong>{instance.label}</strong>}
                                    <code className={instance.label === localName(instance.iri) ? 'instance-iri-only' : ''} title={instance.iri}>{instance.iri}</code>
                                    <span className="instance-data-properties" aria-label="Data properties and values">
                                        {instance.dataProperties.length > 0
                                            ? instance.dataProperties.map((property) => <span className="instance-data-value" key={property}>{property}</span>)
                                            : <span className="no-data-properties">No data values</span>}
                                    </span>
                                </span>
                                <ExternalLink size={14} />
                            </button>)}
                        </div>}
                        {(instancePage > 0 || instances.length === instancePageSize) && <div className="pagination">
                            <button disabled={instancePage === 0 || instancesLoading} onClick={() => {
                                const nextPage = instancePage - 1
                                setInstancePage(nextPage)
                                void loadInstances(selectedClass.iri, nextPage, instancePageSize)
                            }}><ChevronLeft size={15} /> Previous</button>
                            <span>Page {instancePage + 1}{instanceSearch ? '' : ` of ${Math.ceil(selectedClass.instanceCount / instancePageSize)}`}</span>
                            <button disabled={instances.length < instancePageSize || instancesLoading} onClick={() => {
                                const nextPage = instancePage + 1
                                setInstancePage(nextPage)
                                void loadInstances(selectedClass.iri, nextPage, instancePageSize)
                            }}>Next <ChevronRight size={15} /></button>
                        </div>}
                    </section>
                    {propertiesError && <div className="notice error"><AlertCircle size={20} /><div><strong>Loading failed</strong><p>{propertiesError}</p></div><button onClick={() => void showProperties(selectedClass)}>Try again</button></div>}
                    {propertiesLoading && <div className="loading"><LoaderCircle className="spin" size={28} /><span>Loading properties …</span></div>}
                    {!propertiesLoading && !propertiesError && properties.length === 0 && <div className="empty"><Search size={30} /><strong>No properties found</strong><span>No datatype or object properties are defined for this class.</span></div>}
                    {!propertiesLoading && !propertiesError && properties.length > 0 && <div className="property-list property-page-list">
                        {properties.map((property) => <div className="property-row" key={`${property.iri}|${property.originClass}`}>
                            <span className={`property-kind ${property.kind}`}>{property.kind === 'datatype' ? 'Data property' : 'Object property'}</span>
                            <strong>{property.label}</strong>
                            <code title={property.iri}>{property.iri}</code>
                            {property.range && <span className="property-range">→ {localName(property.range)}</span>}
                            <span className="property-origin">{property.originClass === selectedClass.iri ? 'Defined in' : 'Inherited from'} {property.originLabel}</span>
                        </div>)}
                    </div>}
                </section>
                <footer>{lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString('en-GB')}` : 'Connecting to the triple store …'}</footer>
            </main>
        )
    }

    return (
        <main className="shell">
            <header className="topbar">
                <div className="brand"><span className="brand-mark">H</span><span>HEO <strong>Explorer</strong></span></div>
                <div className="header-actions">
                    <button className="refresh-button" onClick={() => { setShowDiagram(true); setDiagramMode('properties'); navigateTo('diagram') }}>
                        Diagram
                    </button>
                    <button className="refresh-button" onClick={() => { setShowSparql(true); navigateTo('sparql') }}>
                        SPARQL
                    </button>
                    <button className="refresh-button" onClick={() => { setShowTBox(true); navigateTo('tbox') }}>
                        TBox
                    </button>
                    <button className="refresh-button" onClick={() => { setShowGlobalInstances(true); setGlobalInstancePage(0); navigateTo('instances'); void loadGlobalInstances(0, globalInstancePageSize, globalInstanceSearch) }}>
                        <Search size={16} /> Search all instances
                    </button>
                    <button className="refresh-button" onClick={() => void loadClasses()} disabled={loading}>
                        <RefreshCw size={16} className={loading ? 'spin' : ''} /> Refresh
                    </button>
                </div>
            </header>

            <section className="hero">
                <div>
                    <p className="eyebrow">Ontology Explorer</p>
                    <h1>HEO Classes</h1>
                    <p className="intro">All available classes from the HEO ontology at a glance.</p>
                </div>
                <div className="status-pill"><span className="status-dot" /> HEO namespace only</div>
            </section>

            <section className="toolbar" aria-label="Filter classes">
                <div className="search-field">
                    <Search size={18} />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search classes …" aria-label="Search classes" />
                    {search && <button className="clear-search" onClick={() => setSearch('')} aria-label="Clear search">×</button>}
                </div>
                <div className="filter-group" role="group" aria-label="Filter by instances">
                    <button className={instanceFilter === 'all' ? 'active' : ''} onClick={() => setInstanceFilter('all')}>All</button>
                    <button className={instanceFilter === 'with-instances' ? 'active' : ''} onClick={() => setInstanceFilter('with-instances')}>With instances</button>
                    <button className={instanceFilter === 'without-instances' ? 'active zero-filter' : 'zero-filter'} onClick={() => setInstanceFilter('without-instances')}>Without instances</button>
                </div>
                <div className="count">{classesWithInstances} <span>of {totalClasses} classes</span></div>
            </section>

            {error && <div className="notice error"><AlertCircle size={20} /><div><strong>Loading failed</strong><p>{error} Please check the connection to <code>mathhub.info</code>.</p></div><button onClick={() => void loadClasses()}>Try again</button></div>}
            {!error && loading && <div className="loading"><LoaderCircle className="spin" size={28} /><span>Loading classes from the ontology …</span></div>}
            {!error && !loading && filteredClasses.length === 0 && <div className="empty"><Search size={30} /><strong>No classes found</strong><span>Try a different search term.</span></div>}
            {!error && !loading && filteredClasses.length > 0 && (
                <section className="class-grid" aria-label="HEO classes">
                    {filteredClasses.map((item, index) => (
                        <article
                            className="class-card"
                            key={item.iri}
                            onClick={() => void showProperties(item)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') void showProperties(item)
                            }}
                            role="button"
                            tabIndex={0}
                        >
                            <div className="card-top">
                                <span className="number">{String(index + 1).padStart(2, '0')}</span>
                                {item.instanceCount > 0
                                    ? <CheckCircle2 size={17} aria-label="Class has instances" />
                                    : <XCircle className="empty-class-icon" size={17} aria-label="Class has no instances" />}
                            </div>
                            <h2>{item.notation}</h2>
                            <p>{item.localName}</p>
                            <div className="instance-count"><strong className={item.instanceCount === 0 ? 'zero-count' : ''}>{item.instanceCount}</strong> {item.instanceCount === 1 ? 'instance' : 'instances'}</div>
                            <a href={item.iri} target="_blank" rel="noreferrer" title={item.iri}>{item.iri}<ExternalLink size={13} /></a>
                        </article>
                    ))}
                </section>
            )}
            <footer>{lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString('en-GB')}` : 'Connecting to the triple store …'}</footer>
        </main>
    )
}

export default App
