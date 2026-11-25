const prefixes = {
    heo: 'https://mathhub.info/heo#',
    ulo: 'http://mathhub.info/ulo#',
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
}

const prefixDeclarations = Object.entries(prefixes).map(([prefix, iri]) => `PREFIX ${prefix}: <${iri}>`).join('\n')

export const questionTBoxQuery = `${prefixDeclarations}
SELECT DISTINCT ?subject ?predicate ?object WHERE {
    {
        ?subject a ?object .
        VALUES ?object {
            owl:Class rdfs:Class rdf:Property owl:ObjectProperty owl:DatatypeProperty
            owl:AnnotationProperty owl:FunctionalProperty owl:InverseFunctionalProperty
            owl:SymmetricProperty owl:AsymmetricProperty owl:TransitiveProperty
        }
        FILTER(STRSTARTS(STR(?subject), STR(heo:)) || STRSTARTS(STR(?subject), STR(ulo:)))
        BIND(rdf:type AS ?predicate)
    }
    UNION {
        ?subject ?predicate ?object .
        FILTER(STRSTARTS(STR(?subject), STR(heo:)) || STRSTARTS(STR(?subject), STR(ulo:)))
        VALUES ?predicate {
            rdfs:subClassOf rdfs:subPropertyOf rdfs:domain rdfs:range
            owl:equivalentClass owl:equivalentProperty owl:disjointWith owl:inverseOf
            owl:unionOf owl:intersectionOf owl:oneOf owl:complementOf owl:propertyChainAxiom
        }
    }
    UNION {
        ?root ?link ?expression .
        VALUES ?link {
            rdfs:subClassOf rdfs:domain rdfs:range owl:equivalentClass
            owl:unionOf owl:intersectionOf owl:oneOf owl:complementOf owl:propertyChainAxiom
        }
        FILTER(isBlank(?expression) && (STRSTARTS(STR(?root), STR(heo:)) || STRSTARTS(STR(?root), STR(ulo:))))
        ?expression (owl:unionOf|owl:intersectionOf|owl:oneOf|owl:complementOf|rdf:rest|rdf:first|owl:onClass|owl:onDataRange|owl:someValuesFrom|owl:allValuesFrom)* ?subject .
        FILTER(isBlank(?subject))
        ?subject ?predicate ?object .
        VALUES ?predicate {
            rdf:type rdf:first rdf:rest owl:unionOf owl:intersectionOf owl:oneOf owl:complementOf
            owl:onProperty owl:onClass owl:onDataRange owl:someValuesFrom owl:allValuesFrom owl:hasValue
            owl:minCardinality owl:maxCardinality owl:cardinality
            owl:minQualifiedCardinality owl:maxQualifiedCardinality owl:qualifiedCardinality
        }
    }
}`

export type SparqlBinding = { value: string; type?: string; datatype?: string; 'xml:lang'?: string }
export type SparqlRow = Record<string, SparqlBinding>

function compactTerm(term: SparqlBinding) {
    if (term.type === 'bnode') return `_:${term.value}`
    if (term.type === 'uri') {
        for (const [prefix, namespace] of Object.entries(prefixes)) {
            if (term.value.startsWith(namespace)) return prefix + ':' + term.value.slice(namespace.length)
        }
        return `<${term.value}>`
    }
    const suffix = term['xml:lang'] ? `@${term['xml:lang']}` : term.datatype ? `^^<${term.datatype}>` : ''
    return JSON.stringify(term.value) + suffix
}

export function formatQuestionTBox(rows: SparqlRow[]) {
    const triples = rows.flatMap((row) => {
        const terms = ['subject', 'predicate', 'object'].map((name) => row[name] ?? row[`?${name}`])
        return terms.every((term) => typeof term?.value === 'string') ? [terms.map(compactTerm).join(' ')] : []
    })
    return triples.length ? prefixDeclarations + '\n' + triples.sort().join('\n') : ''
}

const ontologyPredicateNamespace = /^https?:\/\/mathhub\.info\/(?:heo|ulo)#/

export function isOntologyPredicate(iri: string) {
    return ontologyPredicateNamespace.test(iri)
}

export const ontologyPredicatesQuery = `${prefixDeclarations}
SELECT DISTINCT ?predicate WHERE {
    ?subject ?predicate ?object .
    FILTER(STRSTARTS(STR(?predicate), STR(heo:)) || STRSTARTS(STR(?predicate), STR(ulo:)))
}`

export function tboxPredicates(rows: SparqlRow[]) {
    const predicates = new Set<string>()
    for (const row of rows) {
        const subject = (row.subject ?? row['?subject'])?.value
        const predicate = (row.predicate ?? row['?predicate'])?.value
        const object = (row.object ?? row['?object'])?.value
        if (!subject || !object) continue
        if (isOntologyPredicate(subject) && (
            (predicate === prefixes.rdf + 'type' && object.endsWith('Property'))
            || predicate === prefixes.rdfs + 'domain'
            || predicate === prefixes.rdfs + 'range'
            || predicate === prefixes.rdfs + 'subPropertyOf'
            || predicate === prefixes.owl + 'inverseOf'
            || predicate === prefixes.owl + 'equivalentProperty'
            || predicate === prefixes.owl + 'propertyChainAxiom'
        )) predicates.add(subject)
        if (isOntologyPredicate(object) && (
            predicate === prefixes.rdfs + 'subPropertyOf'
            || predicate === prefixes.owl + 'onProperty'
            || predicate === prefixes.owl + 'inverseOf'
            || predicate === prefixes.owl + 'equivalentProperty'
        )) predicates.add(object)
    }
    return predicates
}
