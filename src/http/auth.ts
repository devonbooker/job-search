import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export function persistToken(token: string, path: string): void {
  writeFileSync(path, token, { encoding: 'utf-8' })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows may not honor chmod; swallow
  }
}

export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, 'utf-8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return t
  }
  const t = generateToken()
  persistToken(t, path)
  return t
}
