export function isBeginnerMode(): boolean {
  const stored = localStorage.getItem('websky_beginner_mode')
  return stored === null ? true : stored === 'true'
}
