export type QuestionAnswer = {
    query: string
    result: { boolean: boolean } | { columns: string[]; rows: (string | null)[][]; moreResults: boolean }
}
