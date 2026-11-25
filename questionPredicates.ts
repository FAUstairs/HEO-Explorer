import { isOntologyPredicate } from './questionTBox'

export function collectOntologyPredicates(parsedQuery: unknown): string[] {
    const predicates = new Set<string>()
    function visitPath(node: unknown) {
        if (!node || typeof node !== 'object') return
        if ('termType' in node && node.termType === 'NamedNode' && 'value' in node && typeof node.value === 'string'
            && isOntologyPredicate(node.value)) predicates.add(node.value)
        if ('items' in node && Array.isArray(node.items)) node.items.forEach(visitPath)
    }
    function visit(node: unknown) {
        if (!node || typeof node !== 'object') return
        if ('type' in node && node.type === 'bgp' && 'triples' in node && Array.isArray(node.triples)) {
            for (const triple of node.triples) visitPath(triple.predicate)
            return
        }
        Object.values(node).forEach(visit)
    }
    visit(parsedQuery)
    return [...predicates]
}

const ignoredWords = new Set(['has', 'is', 'of', 'for', 'by', 'the', 'at', 'in', 'to'])

function words(iri: string) {
    return iri.slice(iri.lastIndexOf('#') + 1).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function editDistance(a: string, b: string) {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
    for (let i = 1; i <= a.length; i++) {
        const current = [i]
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]))
        }
        previous = current
    }
    return previous[b.length]
}

export function similarPredicates(iri: string, candidates: Iterable<string>): string[] {
    const sourceWords = words(iri)
    const sourceName = sourceWords.join('')
    const sourceTerms = new Set(sourceWords.filter((word) => !ignoredWords.has(word)))
    return [...candidates].filter((candidate) => candidate !== iri).map((candidate) => {
        const candidateWords = words(candidate)
        const candidateName = candidateWords.join('')
        // Bound comparison work for unusual IRIs.
        const distance = sourceName.length <= 80 && candidateName.length <= 80
            ? editDistance(sourceName, candidateName) : Infinity
        const spelling = 1 - distance / Math.max(sourceName.length, candidateName.length, 1)
        const overlap = candidateWords.filter((word) => sourceTerms.has(word)).length
        return { candidate, score: Math.max(spelling, overlap ? 0.45 + Math.min(overlap, 3) * 0.12 : 0) }
    }).filter(({ score }) => score >= 0.5)
        .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
        .slice(0, 4).map(({ candidate }) => candidate)
}
