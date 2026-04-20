export function parseClaudeJson<T>(text: string): T {
  const trimmed = text.trim()

  const candidates: string[] = []

  const fenced = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1].trim())

  const firstObj = trimmed.indexOf('{')
  const firstArr = trimmed.indexOf('[')
  const start =
    firstObj === -1 ? firstArr :
    firstArr === -1 ? firstObj :
    Math.min(firstObj, firstArr)
  if (start >= 0) {
    const lastObj = trimmed.lastIndexOf('}')
    const lastArr = trimmed.lastIndexOf(']')
    const end = Math.max(lastObj, lastArr)
    if (end > start) candidates.push(trimmed.slice(start, end + 1))
  }

  candidates.push(trimmed)

  let lastErr: unknown
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T
    } catch (err) {
      lastErr = err
    }
  }

  const preview = trimmed.length > 400 ? trimmed.slice(0, 400) + '...[truncated]' : trimmed
  const cause = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`parseClaudeJson failed (${cause}). Text was: ${JSON.stringify(preview)}`)
}
