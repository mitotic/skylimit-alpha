const READ_ONLY_MODE_DEFAULT = false

export function isReadOnlyMode(): boolean {
  const stored = localStorage.getItem('websky_read_only_mode')
  if (stored !== null) return stored === 'true'
  return READ_ONLY_MODE_DEFAULT
}
