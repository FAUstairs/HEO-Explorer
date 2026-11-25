import { classNamespaces, type ClassNamespace } from './classNamespaces'
import ExplorerHeader from './ExplorerHeader'
import { authenticatedFetch } from './api'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs/lib/elk-api.js'
import { AlertCircle, ArrowLeft, LoaderCircle, Maximize, Minus, Plus, RefreshCw } from 'lucide-react'
import type { HeoClass } from './App'

type Binding = { value?: string; type?: string }
type ResultRow = Record<string, Binding | string | null | undefined>

type DiagramEdge = {
    property: string
    label: string
    comment: string
    domain: string
    range: string
    type: 'datatype' | 'object'
}

type LayoutPoint = { x: number; y: number; width: number; height: number }
type LayoutSection = { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }
type LayoutLabel = { x?: number; y?: number; width?: number; height?: number }
type LayoutEdge = { id: string; sections?: LayoutSection[]; labels?: LayoutLabel[] }
type Size = { width: number; height: number }
type Position = { x: number; y: number }
type DiagramView = { zoom: number; pan: Position }
const defaultView: DiagramView = { zoom: 1, pan: { x: 0, y: 0 } }
const maxZoom = 2.5
const viewportPadding = 5
const controlsClearance = 50

function fitDiagram(canvas: Size, viewport: Size) {
    const top = Math.min(controlsClearance, viewport.height / 2)
    const availableHeight = viewport.height - top
    const zoom = Math.min(maxZoom, viewport.width / canvas.width, availableHeight / canvas.height)
    return {
        zoom,
        pan: { x: (viewport.width - canvas.width * zoom) / 2, y: top + (availableHeight - canvas.height * zoom) / 2 },
    }
}

type DiagramProps = {
    namespace: ClassNamespace
    onChangeNamespace: (namespace: ClassNamespace) => void
    endpoint: string
    token: string
    onLogout: () => void
    onChangePassword: () => void
    onAdmin?: () => void
    classes: HeoClass[]
    classesLoading: boolean
    classesError: string | null
    onReloadClasses: () => Promise<void>
    mode?: 'properties' | 'subclasses'
    onBack: () => void
    onOpenClass: (classIri: string) => void
    onChangeMode: (mode: 'properties' | 'subclasses') => void
}

const propertyQuery = (namespace: ClassNamespace) => `
PREFIX ontology: <${classNamespaces[namespace]}>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT DISTINCT ?property ?propertyLabel ?propertyComment ?propertyType ?domain ?range WHERE {
  ?property a ?propertyType ;
            rdfs:domain ?domain .
  VALUES ?propertyType { owl:DatatypeProperty owl:ObjectProperty }
  FILTER(STRSTARTS(STR(?domain), STR(ontology:)))
  OPTIONAL { ?property rdfs:label ?propertyLabel . }
  OPTIONAL { ?property rdfs:comment ?propertyComment . }
  OPTIONAL { ?property rdfs:range ?range . }
}
ORDER BY STR(?domain) STR(?property)`

const subclassQuery = (namespace: ClassNamespace) => `
PREFIX ontology: <${classNamespaces[namespace]}>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT DISTINCT ?domain ?range ?propertyComment WHERE {
  ?domain rdfs:subClassOf ?range .
  FILTER(STRSTARTS(STR(?domain), STR(ontology:)))
  FILTER(STRSTARTS(STR(?range), STR(ontology:)))
  OPTIONAL { <http://www.w3.org/2000/01/rdf-schema#subClassOf> rdfs:comment ?propertyComment . }
}
ORDER BY STR(?range) STR(?domain)`

function valueOf(value: Binding | string | null | undefined): string {
    return typeof value === 'string' ? value : value?.value ?? ''
}

function localName(iri: string): string {
    return iri.split(/[/#]/).pop() || iri
}

function parseEdges(payload: unknown, mode: 'properties' | 'subclasses'): DiagramEdge[] {
    const rows = Array.isArray(payload)
        ? payload
        : (payload as { results?: { bindings?: ResultRow[] }; bindings?: ResultRow[] })?.results?.bindings
        ?? (payload as { bindings?: ResultRow[] })?.bindings
        ?? []
    const unique = new Map<string, DiagramEdge>()
    for (const row of rows as ResultRow[]) {
        const property = mode === 'subclasses' ? 'http://www.w3.org/2000/01/rdf-schema#subClassOf' : valueOf(row.property)
        const domain = valueOf(row.domain)
        if (!property || !domain) continue
        unique.set(`${property}|${domain}|${valueOf(row.range)}`, {
            property,
            label: mode === 'subclasses' ? 'subclass of' : valueOf(row.propertyLabel) || localName(property),
            comment: valueOf(row.propertyComment).trim(),
            domain,
            range: valueOf(row.range),
            type: mode === 'subclasses'
                ? 'object'
                : valueOf(row.propertyType).endsWith('DatatypeProperty') ? 'datatype' : 'object',
        })
    }
    return [...unique.values()]
}

export default function Diagram({ namespace, onChangeNamespace, endpoint, token, classes, classesLoading, classesError, onReloadClasses, mode = 'properties', onLogout, onChangePassword, onAdmin, onBack, onOpenClass, onChangeMode }: DiagramProps) {
    const [edges, setEdges] = useState<DiagramEdge[]>([])
    const [literalEdges, setLiteralEdges] = useState<DiagramEdge[]>([])
    const [edgesLoading, setLoading] = useState(true)
    const [edgesError, setError] = useState<string | null>(null)
    const [manualViews, setManualViews] = useState<Record<'properties' | 'subclasses', DiagramView | null>>({
        properties: null,
        subclasses: null,
    })
    const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
    const [hoveredClass, setHoveredClass] = useState<string | null>(null)
    const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
    const [selectedClass, setSelectedClass] = useState<string | null>(null)
    const panStart = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)
    const diagramViewport = useRef<HTMLDivElement | null>(null)
    const [viewportSize, setViewportSize] = useState<Size | null>(null)
    const loading = classesLoading || edgesLoading
    const error = classesError ?? edgesError

    const loadDiagram = async (signal?: AbortSignal) => {
        setLoading(true)
        setError(null)
        try {
            const requests = [
                authenticatedFetch(endpoint, token, {
                    method: 'POST',
                    signal,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: new URLSearchParams({ query: mode === 'subclasses' ? subclassQuery(namespace) : propertyQuery(namespace) }),
                }),
            ]
            if (mode === 'subclasses') {
                requests.push(authenticatedFetch(endpoint, token, {
                    method: 'POST',
                    signal,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: new URLSearchParams({ query: propertyQuery(namespace) }),
                }))
            }
            const responses = await Promise.all(requests)
            if (responses.some((response) => !response.ok)) {
                throw new Error('The ontology service could not load the diagram data.')
            }
            const payloads = await Promise.all(responses.map((response) => response.json()))
            if (signal?.aborted) return
            setEdges(parseEdges(payloads[0], mode))
            setLiteralEdges(mode === 'subclasses' ? parseEdges(payloads[1], 'properties') : parseEdges(payloads[0], 'properties'))
        } catch (cause) {
            if (signal?.aborted) return
            setError(cause instanceof Error ? cause.message : 'The diagram could not be loaded.')
        } finally {
            if (!signal?.aborted) setLoading(false)
        }
    }

    useEffect(() => {
        const controller = new AbortController()
        void loadDiagram(controller.signal)
        return () => controller.abort()
    }, [endpoint, mode, namespace, token])

    const classMap = useMemo(() => new Map(classes.map((item) => [item.iri, item])), [classes])
    const edgeId = (edge: DiagramEdge) => `edge-${edge.domain}-${edge.range}-${edge.property}`
    const domainEdges = useMemo(
        () => edges.filter((edge) => classMap.has(edge.domain)),
        [classMap, edges],
    )
    const visibleEdges = useMemo(
        () => domainEdges.filter((edge) => !edge.range || classMap.has(edge.range)),
        [classMap, domainEdges],
    )
    const nodeWidth = 190
    const nodeHeight = 70
    const padding = 42
    const [layout, setLayout] = useState<{ nodes: Map<string, LayoutPoint>; edges: Map<string, LayoutEdge>; width: number; height: number } | null>(null)
    useEffect(() => {
        let cancelled = false
        if (loading || error) return
        const elk = new ELK()
        const graph: ElkNode = {
            id: namespace,
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.edgeRouting': 'ORTHOGONAL',
                'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
                'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
                'elk.spacing.nodeNode': '28',
                'elk.layered.spacing.nodeNodeBetweenLayers': '52',
                'elk.spacing.edgeNode': '18',
                'elk.spacing.edgeLabel': '14',
                'elk.edgeLabels.inline': 'false',
                'elk.edgeLabels.placement': 'CENTER',
                'elk.layered.edgeLabels.sideSelection': 'SMART_DOWN',
            },
            children: classes.map((item) => ({ id: item.iri, width: nodeWidth, height: nodeHeight })),
            edges: visibleEdges.filter((edge) => edge.range && edge.domain !== edge.range).map((edge, index) => ({
                id: edgeId(edge),
                sources: [edge.domain],
                targets: [edge.range],
                labels: [{ text: edge.label, width: Math.max(48, edge.label.length * 7), height: 20 }],
            })),
        }
        void elk.layout(graph).then((result) => {
            if (cancelled) return
            const nodes = new Map((result.children ?? []).map((node) => [node.id, {
                x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? nodeWidth, height: node.height ?? nodeHeight,
            }]))
            const edgeLayouts = new Map((result.edges ?? []).map((edge) => [edge.id, edge as LayoutEdge]))
            setLayout({ nodes, edges: edgeLayouts, width: (result.width ?? nodeWidth) + padding * 2, height: (result.height ?? nodeHeight) + padding * 2 })
        }).catch(() => {
            if (!cancelled) setLayout(null)
        })
        return () => { cancelled = true }
    }, [classes, error, loading, namespace, visibleEdges])
    const diagramVisible = !loading && !error && layout !== null
    useLayoutEffect(() => {
        const viewport = diagramViewport.current
        if (!diagramVisible || !viewport) return
        const measure = () => {
            const width = viewport.clientWidth - viewportPadding * 2
            const height = viewport.clientHeight - viewportPadding * 2
            if (width > 0 && height > 0) setViewportSize({ width, height })
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(viewport)
        return () => observer.disconnect()
    }, [diagramVisible])

    const fittedView = useMemo(() => layout && viewportSize ? fitDiagram(layout, viewportSize) : null, [layout, viewportSize])
    const minZoom = Math.min(.5, fittedView?.zoom ?? .5)
    const { zoom, pan } = manualViews[mode] ?? fittedView ?? defaultView

    function setManualView(view: DiagramView | null) {
        setManualViews((current) => ({ ...current, [mode]: view }))
    }

    function zoomAt(factor: number, anchor: Position) {
        const nextZoom = Math.max(minZoom, Math.min(maxZoom, zoom * factor))
        if (nextZoom === zoom) return
        const ratio = nextZoom / zoom
        setManualView({
            zoom: nextZoom,
            pan: { x: anchor.x - (anchor.x - pan.x) * ratio, y: anchor.y - (anchor.y - pan.y) * ratio },
        })
    }

    function zoomFromCentre(factor: number) {
        if (viewportSize) zoomAt(factor, { x: viewportSize.width / 2, y: viewportSize.height / 2 })
    }

    useEffect(() => {
        setHoveredEdge(null)
        setHoveredClass(null)
        setSelectedEdge(null)
        setSelectedClass(null)
    }, [mode])

    const canvasWidth = layout?.width ?? nodeWidth + padding * 2
    const canvasHeight = layout?.height ?? nodeHeight + padding * 2
    const literalPredicates = (classIri: string) => literalEdges
        .filter((edge) => classMap.has(edge.domain))
        .filter((edge) => edge.domain === classIri && edge.type === 'datatype')
        .map((edge) => edge.label)
        .filter((label, index, labels) => labels.indexOf(label) === index)
    const activeEdge = selectedEdge ?? hoveredEdge
    const activeClass = selectedClass ?? hoveredClass
    const activeEdgeComment = activeEdge
        ? visibleEdges.find((edge) => edgeId(edge) === activeEdge)?.comment ?? ''
        : ''
    const hasSelection = selectedEdge !== null || selectedClass !== null
    const position = (iri: string) => {
        const point = layout?.nodes.get(iri)
        return point ? { ...point, x: point.x + padding, y: point.y + padding } : { x: padding, y: padding, width: nodeWidth, height: nodeHeight }
    }

    return (
        <main className="shell diagram-shell">
            <ExplorerHeader onHome={onBack} onAdmin={onAdmin} onLogout={onLogout} onChangePassword={onChangePassword}>
                <button className="refresh-button" onClick={onBack}><ArrowLeft size={16} /> Back to classes</button>
            </ExplorerHeader>
            <section className="property-page diagram-page">
                <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to all classes</button>
                <div className="diagram-heading">
                    <div><p className="eyebrow">Ontology map</p><h1>{mode === 'subclasses' ? 'Class hierarchy' : 'Classes & predicates'}</h1><p className="intro">{mode === 'subclasses' ? `Explore the inheritance structure of ${namespace} classes.` : `Explore how ${namespace} classes are connected through their predicates.`}</p></div>
                    <div className="diagram-heading-actions">
                        <div className="diagram-tabs" role="group" aria-label="Ontology namespace">
                            {(['HEO', 'ULO'] as const).map((option) => (
                                <button key={option} className={namespace === option ? 'active' : ''} aria-pressed={namespace === option} onClick={() => onChangeNamespace(option)}>{option}</button>
                            ))}
                        </div>
                        <div className="diagram-tabs" role="tablist" aria-label="Diagram views">
                            <button className={mode === 'properties' ? 'active' : ''} onClick={() => onChangeMode('properties')} role="tab" aria-selected={mode === 'properties'}>Properties</button>
                            <button className={mode === 'subclasses' ? 'active' : ''} onClick={() => onChangeMode('subclasses')} role="tab" aria-selected={mode === 'subclasses'}>Subclasses</button>
                        </div>
                        <div className="diagram-legend"><span><i className="legend-class" /> Class</span><span><i className="legend-line" /> {mode === 'subclasses' ? 'Subclass' : 'Predicate'}</span></div>
                    </div>
                </div>
                {error && <div className="notice error"><AlertCircle size={20} /><div><strong>Loading failed</strong><p>{error}</p></div><button onClick={() => {
                    if (classesError) void onReloadClasses()
                    if (edgesError) void loadDiagram()
                }}><RefreshCw size={14} /> Try again</button></div>}
                {loading && <div className="loading"><LoaderCircle className="spin" size={28} /><span>Building ontology diagram …</span></div>}
                {!loading && !error && <div className="diagram-summary"><span><strong>{classes.length}</strong> classes</span><span><strong>{visibleEdges.length}</strong> predicate connections</span></div>}
                {!loading && !error && !layout && <div className="loading"><LoaderCircle className="spin" size={28} /><span>Calculating graph layout …</span></div>}
                {!loading && !error && layout && <div className="diagram-frame">
                    <div className="diagram-controls" aria-label="Diagram zoom controls">
                        <button onClick={() => zoomFromCentre(1 / 1.2)} disabled={zoom <= minZoom} aria-label="Zoom out"><Minus size={15} /></button>
                        <button className="diagram-zoom-value" onClick={() => setManualView(defaultView)} aria-label="Reset zoom">{zoom < .01 ? '<1%' : `${Math.round(zoom * 100)}%`}</button>
                        <button onClick={() => zoomFromCentre(1.2)} disabled={zoom >= maxZoom} aria-label="Zoom in"><Plus size={15} /></button>
                        <button className="diagram-fit-button" onClick={() => setManualView(null)} disabled={!fittedView} aria-label="Fit entire diagram to screen" title="Fit entire diagram to screen"><Maximize size={15} /> Fit</button>
                    </div>
                    <div
                        ref={diagramViewport}
                        className={`diagram-scroll ${panStart.current ? 'is-panning' : ''}`}
                        onPointerDown={(event) => {
                            if (event.button !== 0) return
                            event.preventDefault()
                            panStart.current = { pointerX: event.clientX, pointerY: event.clientY, x: pan.x, y: pan.y }
                            event.currentTarget.setPointerCapture(event.pointerId)
                        }}
                        onPointerMove={(event) => {
                            const start = panStart.current
                            if (!start) return
                            event.preventDefault()
                            const dx = event.clientX - start.pointerX
                            const dy = event.clientY - start.pointerY
                            if (dx !== 0 || dy !== 0 || manualViews[mode]) {
                                setManualView({ zoom, pan: { x: start.x + dx, y: start.y + dy } })
                            }
                        }}
                        onPointerUp={(event) => {
                            panStart.current = null
                            event.currentTarget.releasePointerCapture(event.pointerId)
                        }}
                        onPointerCancel={() => { panStart.current = null }}
                        onWheel={(event) => {
                            event.preventDefault()
                            const viewport = event.currentTarget
                            const bounds = viewport.getBoundingClientRect()
                            zoomAt(Math.pow(.92, event.deltaY / 100), {
                                x: event.clientX - bounds.left - viewport.clientLeft - viewportPadding,
                                y: event.clientY - bounds.top - viewport.clientTop - viewportPadding,
                            })
                        }}
                    >
                    <svg className="ontology-diagram" style={{ transform: `translate(${pan.x}px, ${pan.y}px)`, visibility: fittedView ? undefined : 'hidden' }} width={canvasWidth * zoom} height={canvasHeight * zoom} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} role="img" aria-label={`${namespace} ${mode === 'subclasses' ? 'class hierarchy' : 'class and predicate diagram'}`}>
                        <defs>
                            <marker id="diagram-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--diagram-edge, #86a4bd)" /></marker>
                        </defs>
                        {classes.map((item) => {
                            const point = position(item.iri)
                            const hoveredConnection = visibleEdges.some((edge) => (
                                edgeId(edge) === activeEdge
                                && (edge.domain === item.iri || edge.range === item.iri)
                            ))
                            const connectedOutgoing = activeClass !== item.iri && visibleEdges.some((edge) => (
                                edge.domain === activeClass && edge.range === item.iri
                            ))
                            const connectedIncoming = activeClass !== item.iri && visibleEdges.some((edge) => (
                                edge.range === activeClass && edge.domain === item.iri
                            ))
                            return <g
                                className={[
                                    'diagram-node',
                                    activeClass === item.iri || hoveredConnection ? 'hovered' : '',
                                    connectedOutgoing ? 'connected-outgoing' : '',
                                    connectedIncoming ? 'connected-incoming' : '',
                                ].filter(Boolean).join(' ')}
                                key={item.iri}
                                transform={`translate(${point.x}, ${point.y})`}
                                onPointerDown={(event) => {
                                    event.stopPropagation()
                                    event.preventDefault()
                                    setSelectedClass((current) => current === item.iri ? null : item.iri)
                                    setSelectedEdge(null)
                                    setHoveredClass(null)
                                    setHoveredEdge(null)
                                }}
                                onMouseEnter={() => { if (!hasSelection) setHoveredClass(item.iri) }}
                                onMouseLeave={() => { if (!hasSelection) setHoveredClass(null) }}
                                role="button"
                                tabIndex={0}
                            >
                                <rect width={nodeWidth} height={nodeHeight} rx="13" />
                                <circle cx="23" cy="27" r="7" />
                                <text className="diagram-node-label" x="42" y="31">{item.notation.slice(0, 27)}{item.notation.length > 27 ? '…' : ''}</text>
                                <text className="diagram-node-meta" x="18" y="59">{item.instanceCount.toLocaleString('en-GB')} instances</text>
                            </g>
                        })}
                        {visibleEdges.filter((edge) => edge.range && edge.domain !== edge.range).map((edge) => {
                            const id = edgeId(edge)
                            const sections = layout.edges.get(id)?.sections ?? []
                            const points = sections.flatMap((section, sectionIndex) => [
                                ...(sectionIndex === 0 ? [section.startPoint] : []),
                                ...(section.bendPoints ?? []),
                                section.endPoint,
                            ])
                            if (points.length < 2) return null
                            const path = points.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${point.x + padding} ${point.y + padding}`).join(' ')
                            const label = layout.edges.get(id)?.labels?.[0]
                            const labelX = (label?.x ?? points[Math.floor(points.length / 2)].x) + padding
                            const labelY = (label?.y ?? points[Math.floor(points.length / 2)].y) + padding
                            const labelWidth = label?.width ?? Math.max(48, edge.label.length * 7)
                            const labelHeight = label?.height ?? 20
                            const direction = activeClass === edge.domain
                                ? 'outgoing'
                                : activeClass === edge.range
                                    ? 'incoming'
                                    : ''
                            return <g
                                className={['diagram-edge-group', activeEdge === id ? 'hovered' : '', direction].filter(Boolean).join(' ')}
                                key={id}
                                onClick={(event) => {
                                    event.stopPropagation()
                                    setSelectedEdge((current) => current === id ? null : id)
                                    setSelectedClass(null)
                                    setHoveredEdge(null)
                                    setHoveredClass(null)
                                }}
                                onMouseEnter={() => { if (!hasSelection) setHoveredEdge(id) }}
                                onMouseLeave={() => { if (!hasSelection) setHoveredEdge(null) }}
                            >
                                <path className="diagram-edge" d={path} markerEnd="url(#diagram-arrow)" />
                                <g transform={`translate(${labelX}, ${labelY})`}><rect className="diagram-edge-label-bg" x="0" y="0" width={labelWidth} height={labelHeight} rx="10" /><text className="diagram-edge-label" x={labelWidth / 2} y={labelHeight / 2} textAnchor="middle" dominantBaseline="middle">{edge.label}</text></g>
                            </g>
                        })}
                    </svg>
                    {activeClass && (classMap.get(activeClass)?.description || literalPredicates(activeClass).length > 0) && (() => {
                        const comment = classMap.get(activeClass)?.description?.trim() ?? ''
                        const labels = literalPredicates(activeClass)
                        const tooltipWidth = Math.min(nodeWidth + 80, 320)
                        const tooltipHeight = 28 + (comment ? 54 : 0) + (labels.length ? 28 + labels.length * 19 : 0)
                        return <div
                            className="diagram-literal-tooltip"
                            style={{
                                width: `${tooltipWidth}px`,
                                minHeight: `${tooltipHeight}px`,
                            }}
                        >
                            {comment && <section className="diagram-comment-section">
                                <strong className="diagram-literal-title">Comment</strong>
                                <p className="diagram-comment">{comment}</p>
                            </section>}
                            {labels.length > 0 && <section className="diagram-literal-section">
                                <strong className="diagram-literal-title">Literal predicates</strong>
                                {labels.map((label) => <span className="diagram-literal-item" key={label}>{label}</span>)}
                            </section>}
                        </div>
                    })()}
                    {activeEdgeComment && <div className="diagram-predicate-tooltip">
                        <strong className="diagram-literal-title">Comment</strong>
                        <p className="diagram-comment">{activeEdgeComment}</p>
                    </div>}
                    </div>
                </div>}
            </section>
        </main>
    )
}
