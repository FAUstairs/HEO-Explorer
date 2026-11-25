const prefix = 'PREFIX heo: <https://mathhub.info/heo#>'

const moduleLinks = `
    ?account heo:moduleAccountDefinedBy ?regulation .
    ?entry heo:isInModuleAccount ?account ; heo:basedOnModule ?module .
    ?module a heo:Module .`

const programmeLinks = `
    ?programme a heo:CourseOfStudy .
    ?regulation heo:definesProgram ?programme .
    ${moduleLinks}`

const moduleLabel = `
    OPTIONAL { ?module heo:moduleName ?englishName . FILTER(LANGMATCHES(LANG(?englishName), "en")) }
    OPTIONAL { ?module heo:moduleName ?localName . FILTER(!LANGMATCHES(LANG(?localName), "en")) }`

const moduleName = 'COALESCE(SAMPLE(STR(?englishName)), SAMPLE(STR(?localName)), STR(?module))'

// The local endpoint decodes FTML IRIs. Escape characters that cannot occur in an IRI reference.
function iri(value: string) {
    return '<' + value.replace(/[\x00-\x20\x7f<>"{}|^`\\]/g, encodeURIComponent) + '>'
}

export const sharedModulesQuery = `${prefix}
SELECT (?module AS ?group) (${moduleName} AS ?label) ?count WHERE {
    {
        SELECT ?module (COUNT(DISTINCT ?programme) AS ?count) WHERE { ${programmeLinks} }
        GROUP BY ?module
        HAVING(COUNT(DISTINCT ?programme) > 1)
    }
    ${moduleLabel}
}
GROUP BY ?module ?count`

export const moduleProgrammesQuery = (module: string) => `${prefix}
SELECT (?programme AS ?group) (COALESCE(SAMPLE(STR(?title)), STR(?programme)) AS ?label) WHERE {
    VALUES ?module { ${iri(module)} }
    ${programmeLinks}
    OPTIONAL { ?programme heo:programTitle ?title . }
}
GROUP BY ?programme`

export const programmePortfoliosQuery = `${prefix}
SELECT (?programme AS ?group) (COALESCE(SAMPLE(STR(?title)), STR(?programme)) AS ?label) ?modules WHERE {
    {
        SELECT ?programme (GROUP_CONCAT(DISTINCT ENCODE_FOR_URI(STR(?module)); SEPARATOR=" ") AS ?modules) WHERE {
            ${programmeLinks}
        }
        GROUP BY ?programme
    }
    OPTIONAL { ?programme heo:programTitle ?title . }
}
GROUP BY ?programme ?modules`

export const programmeModuleNamesQuery = (programmes: string[]) => `${prefix}
SELECT (?module AS ?group) (${moduleName} AS ?label) WHERE {
    VALUES ?programme { ${programmes.map(iri).join(' ')} }
    ${programmeLinks}
    ${moduleLabel}
}
GROUP BY ?module`

// The sixth Campo key field is the examination regulation version.
export const regulationCatalogueQuery = `${prefix}
SELECT ?group (COALESCE(SAMPLE(STR(?title)), SAMPLE(STR(?programme))) AS ?label)
       ?regulation (COALESCE(SAMPLE(STR(?code)), STR(?regulation)) AS ?code) WHERE {
    ?programme a heo:CourseOfStudy .
    ?regulation heo:definesProgram ?programme .
    OPTIONAL { ?programme heo:programCampoKey ?campoKey . }
    BIND(IF(BOUND(?campoKey), CONCAT("campo:", REPLACE(STR(?campoKey), "^(([^|]*[|]){5})[^|]*[|]", "$1")), STR(?programme)) AS ?group)
    OPTIONAL { ?programme heo:programTitle ?title . }
    OPTIONAL { ?regulation heo:regulationCode ?code . }
}
GROUP BY ?group ?regulation`

export const regulationModulesQuery = (regulations: string[]) => `${prefix}
SELECT (?module AS ?group) (${moduleName} AS ?label) ?regulation WHERE {
    VALUES ?regulation { ${regulations.map(iri).join(' ')} }
    ${moduleLinks}
    ${moduleLabel}
}
GROUP BY ?module ?regulation`

export const annotatedProgrammesQuery = `${prefix}
SELECT ?programme (COALESCE(SAMPLE(STR(?programmeName)), STR(?programme)) AS ?programmeTitle)
       (COUNT(DISTINCT ?module) AS ?annotatedModules) WHERE {
    {
        SELECT DISTINCT ?programme ?module WHERE {
            ?programme a heo:CourseOfStudy .
            ?regulation heo:definesProgram ?programme .
            ?account heo:partOfModuleAccount*/heo:moduleAccountDefinedBy ?regulation .
            ?entry heo:isInModuleAccount ?account ; heo:basedOnModule ?module .
            ?module heo:teachingPromise ?competency .
            ?competency a heo:Competency .
        }
    }
    OPTIONAL { ?programme heo:programTitle ?programmeName . }
}
GROUP BY ?programme`

export const programmeModuleTotalsQuery = (programmes: string[]) => `${prefix}
SELECT ?programme (COUNT(DISTINCT ?module) AS ?totalModules) WHERE {
    VALUES ?programme { ${programmes.map(iri).join(' ')} }
    ?programme ^heo:definesProgram/^heo:moduleAccountDefinedBy/^heo:partOfModuleAccount* ?account .
    ?entry heo:isInModuleAccount ?account ; heo:basedOnModule ?module .
}
GROUP BY ?programme`

export const programmeModuleAccountsQuery = (programme: string) => `${prefix}
SELECT ?regulation ?account ?parent ?module ?competency
       (COALESCE(SAMPLE(STR(?code)), STR(?regulation)) AS ?regulationTitle)
       (COALESCE(SAMPLE(STR(?accountName)), STR(?account)) AS ?accountTitle)
       (${moduleName} AS ?moduleTitle)
       (COALESCE(SAMPLE(STR(?competencyName)), STR(?competency)) AS ?competencyTitle) WHERE {
    VALUES ?programme { ${iri(programme)} }
    ?regulation heo:definesProgram ?programme .
    OPTIONAL { ?regulation heo:regulationCode ?code . }
    OPTIONAL {
        ?account heo:partOfModuleAccount*/heo:moduleAccountDefinedBy ?regulation .
        OPTIONAL { ?account heo:moduleAccountName ?accountName . }
        OPTIONAL { ?account heo:partOfModuleAccount ?parent . }
        OPTIONAL {
            ?entry heo:isInModuleAccount ?account ; heo:basedOnModule ?module .
            ${moduleLabel}
            OPTIONAL {
                ?module heo:teachingPromise ?competency .
                ?competency a heo:Competency .
                OPTIONAL { ?competency heo:competencyLabel ?competencyName . }
            }
        }
    }
}
GROUP BY ?regulation ?account ?parent ?module ?competency`
