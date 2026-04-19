export function parseClaudeJson<T>(text: string): T {
  const trimmed = text.trim()

  const fenced = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fenced) {
    return JSON.parse(fenced[1].trim()) as T
  }

  const firstObj = trimmed.indexOf('{')
  const firstArr = trimmed.indexOf('[')
  const start =
    firstObj === -1 ? firstArr :
    firstArr === -1 ? firstObj :
    Math.min(firstObj, firstArr)
  if (start > 0) {
    const lastObj = trimmed.lastIndexOf('}')
    const lastArr = trimmed.lastIndexOf(']')
    const end = Math.max(lastObj, lastArr)
    if (end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T
    }
  }

  try {
    return JSON.parse(trimmed) as T
  } catch (err) {
    const preview = trimmed.length > 300 ? trimmed.slice(0, 300) + '...' : trimmed
    throw new Error(`parseClaudeJson failed. Text was: ${JSON.stringify(preview)}`)
  }
}
