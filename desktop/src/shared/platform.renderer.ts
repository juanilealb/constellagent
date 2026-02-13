export const isWindows = true

export function isDebugLoggingEnabled(): boolean {
  return false
}

export function debugLog(_message: string, _details?: unknown): void {
  // no-op in renderer
}

export function resolveDefaultShell(): string {
  return 'cmd.exe'
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

export function basenameSafe(p: string): string {
  const normalized = p.replace(/[\\/]+$/g, '')
  const segments = normalized.split(/[\\/]/)
  return segments[segments.length - 1] || normalized
}

export function formatShortcut(_mac: string, win: string): string {
  return win
}

export function getTempDir(): string {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.TEMP || process.env.TMP || 'C:/Temp'
  }

  return 'C:/Temp'
}
