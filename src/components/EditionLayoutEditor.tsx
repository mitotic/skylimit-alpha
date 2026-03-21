/**
 * Visual editor for simplified edition layouts.
 *
 * Newspaper-style display with mutually exclusive edit modes.
 * Supports: HEAD (common), timed editions, TAIL — all fully editable.
 * Wildcard patterns (@*) editable as blank handle with required topics.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { parseEditionFile, HEAD_EDITION_NUMBER, TAIL_EDITION_NUMBER } from '../curation/skylimitEditions'
import type { Edition } from '../curation/skylimitEditions'
import { getAllFollows, getTextSuggestions } from '../curation/skylimitCache'
import type { FollowInfo, SuggestionsMap, TextSuggestions } from '../curation/types'
import { useSession } from '../auth/SessionContext'
import { getUserLists, getListMembers } from '../api/social'
import { PencilIcon, TrashIcon } from './NavIcons'

// --- Editor State Types ---

interface EditorPattern {
  id: string
  handle: string               // blank or '*' means wildcard (@*)
  textPattern: string          // comma-separated topics (e.g. "tech, science")
}

interface EditorSection {
  id: string
  name: string
  patterns: EditorPattern[]
  collapsed: boolean
}

interface EditorEdition {
  id: string
  type: 'common' | 'timed' | 'tail'
  time: string
  name: string
  sections: EditorSection[]
  collapsed: boolean
}

interface EditorState {
  editions: EditorEdition[]
  warnings: string[]
}

type EditorMode = 'view' | 'add-user' | 'add-section' | 'edit-users' | 'edit-sections' | 'edit-editions' | 'import-list'

// --- Time Options (30-minute intervals, 24-hour format) ---

const TIME_OPTIONS: string[] = []
for (let h = 0; h < 24; h++) {
  for (const m of [0, 30]) {
    TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
}

// --- ID Generator ---

let nextId = 1
function makeId(): string {
  return `e${nextId++}`
}

// --- Conversion Functions ---

function makeEmptyCommon(): EditorEdition {
  return {
    id: makeId(),
    type: 'common',
    time: '',
    name: 'HEAD (common to all editions)',
    sections: [{ id: makeId(), name: '', patterns: [], collapsed: false }],
    collapsed: false,
  }
}

function makeEmptyTail(): EditorEdition {
  return {
    id: makeId(),
    type: 'tail',
    time: '',
    name: 'TAIL (common to all editions)',
    sections: [{ id: makeId(), name: '', patterns: [], collapsed: false }],
    collapsed: false,
  }
}

/**
 * Convert parsed Edition[] + raw text into EditorState
 */
export function parseLayoutToEditor(text: string): EditorState {
  const warnings: string[] = []
  const editions: EditorEdition[] = []

  if (!text.trim()) {
    return { editions: [makeEmptyCommon(), makeEmptyTail()], warnings }
  }

  const parsed = parseEditionFile(text)

  if (parsed.errors.length > 0) {
    warnings.push(...parsed.errors.map(e => `Parse: ${e}`))
  }

  // Process HEAD (editionNumber=0)
  const headEdition = parsed.editions.find(e => e.editionNumber === HEAD_EDITION_NUMBER)
  const common = convertEdition(headEdition, 'common')
  editions.push(common)

  // Process timed editions
  const timedEditions = parsed.editions
    .filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)
    .sort((a, b) => a.editionNumber - b.editionNumber)

  for (const ed of timedEditions) {
    editions.push(convertEdition(ed, 'timed'))
  }

  // Process TAIL as editable edition
  const tailParsed = parsed.editions.find(e => e.editionNumber === TAIL_EDITION_NUMBER)
  const tail = convertEdition(tailParsed, 'tail')
  editions.push(tail)

  return { editions, warnings }
}

function convertEdition(
  parsed: Edition | undefined,
  type: 'common' | 'timed' | 'tail',
): EditorEdition {
  if (!parsed) {
    if (type === 'common') return makeEmptyCommon()
    if (type === 'tail') return makeEmptyTail()
    return {
      id: makeId(),
      type: 'timed',
      time: '',
      name: '',
      sections: [{ id: makeId(), name: '', patterns: [], collapsed: false }],
      collapsed: false,
    }
  }

  const sections: EditorSection[] = []

  for (const sec of parsed.sections) {
    const patterns: EditorPattern[] = []

    for (const pat of sec.patterns) {
      // Wildcard @* stored as blank handle; explicit @* preserved as '*'
      const handle = pat.userPattern === '*' ? '' : pat.userPattern

      patterns.push({
        id: makeId(),
        handle,
        textPattern: pat.textPatterns.map(tp => tp.pattern).join(', '),
      })
    }

    sections.push({
      id: makeId(),
      name: sec.name,
      patterns,
      collapsed: false,
    })
  }

  // Ensure default section exists at index 0
  if (sections.length === 0 || sections[0].name !== '') {
    sections.unshift({ id: makeId(), name: '', patterns: [], collapsed: false })
  }

  const labelMap = {
    common: 'HEAD (common to all editions)',
    tail: 'TAIL (common to all editions)',
    timed: parsed.name,
  }

  return {
    id: makeId(),
    type,
    time: parsed.time,
    name: labelMap[type],
    sections,
    collapsed: false,
  }
}

/**
 * Generate layout text from editor state
 */
export function generateLayoutText(state: EditorState): string {
  const lines: string[] = []

  for (const edition of state.editions) {
    if (edition.type === 'common') {
      // Output common patterns without # HEAD line (no leading blank - it's first)
      const commonLines = generateEditionPatternLines(edition)
      if (commonLines.length > 0) {
        lines.push(...commonLines)
      }
    } else if (edition.type === 'tail') {
      const tailLines = generateEditionPatternLines(edition)
      if (tailLines.length > 0) {
        // Blank line above # TAIL for readability
        if (lines.length > 0) {
          lines.push('')
        }
        lines.push('# TAIL')
        // Always add blank line after # TAIL for readability
        lines.push('')
        lines.push(...tailLines)
      }
    } else {
      // Timed edition — blank line above for readability
      if (lines.length > 0) {
        lines.push('')
      }
      const timeName = edition.name
        ? `# ${edition.time} ${edition.name}`
        : `# ${edition.time}`
      lines.push(timeName)
      const editionLines = generateEditionPatternLines(edition)
      // Blank line after edition header if first content is not a section header
      if (editionLines.length > 0 && !editionLines[0].startsWith('##')) {
        lines.push('')
      }
      lines.push(...editionLines)
    }
  }

  return lines.join('\n').trim()
}

function generateEditionPatternLines(edition: EditorEdition): string[] {
  const lines: string[] = []

  for (const section of edition.sections) {
    if (section.name) {
      // Blank line above section header for readability (if not first line)
      if (lines.length > 0) {
        lines.push('')
      }
      lines.push(`## ${section.name}`)
    }

    for (const pattern of section.patterns) {
      // Blank or '*' handle → serialize as @*
      const handle = (!pattern.handle || pattern.handle === '*') ? '*' : pattern.handle

      if (pattern.textPattern) {
        lines.push(`@${handle}: ${pattern.textPattern}`)
      } else if (handle !== '*') {
        // Only emit bare handle if it's not a wildcard (bare @* is invalid)
        lines.push(`@${handle}`)
      }
      // Skip patterns with wildcard handle and no topics (invalid)
    }
  }

  return lines
}

// --- Handle Autocomplete Component ---

function HandleAutocomplete({
  value,
  onChange,
  follows,
  disabled,
  placeholder,
}: {
  value: string
  onChange: (handle: string) => void
  follows: FollowInfo[]
  disabled?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSearch(value)
  }, [value])

  const filtered = search
    ? follows.filter(f =>
        f.username.toLowerCase().includes(search.toLowerCase()) ||
        (f.displayName || '').toLowerCase().includes(search.toLowerCase())
      ).slice(0, 8)
    : follows.slice(0, 8)

  const handleSelect = useCallback((handle: string) => {
    setSearch(handle)
    onChange(handle)
    setOpen(false)
    setHighlightIndex(-1)
  }, [onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown') {
        setOpen(true)
        e.preventDefault()
      }
      return
    }

    if (e.key === 'ArrowDown') {
      setHighlightIndex(i => Math.min(i + 1, filtered.length - 1))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setHighlightIndex(i => Math.max(i - 1, 0))
      e.preventDefault()
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      handleSelect(filtered[highlightIndex].username)
      e.preventDefault()
    } else if (e.key === 'Escape') {
      setOpen(false)
      setHighlightIndex(-1)
    }
  }, [open, highlightIndex, filtered, handleSelect])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (
        inputRef.current && !inputRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
        setHighlightIndex(-1)
        // Commit whatever is typed
        if (search !== value) onChange(search)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, search, value, onChange])

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={search}
        disabled={disabled}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
          setHighlightIndex(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay to allow click on dropdown item
          setTimeout(() => {
            if (search !== value) onChange(search)
          }, 150)
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || "handle.bsky.social"}
        className="w-full pl-1 pr-3 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
      />
      {open && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto"
        >
          {filtered.map((f, i) => (
            <button
              key={f.username}
              type="button"
              className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 dark:hover:bg-gray-700 ${
                i === highlightIndex ? 'bg-blue-50 dark:bg-gray-700' : ''
              }`}
              onMouseDown={(e) => {
                e.preventDefault()
                handleSelect(f.username)
              }}
            >
              <span className="font-medium">@{f.username}</span>
              {f.displayName && (
                <span className="ml-2 text-gray-500 dark:text-gray-400">{f.displayName}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Text Pattern Autocomplete Component ---

function TextPatternAutocomplete({
  value,
  onChange,
  suggestions,
  priorityPatterns,
}: {
  value: string
  onChange: (pattern: string) => void
  suggestions: TextSuggestions
  priorityPatterns?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSearch(value)
  }, [value])

  // Disable autocomplete when comma-separated topics are present
  const hasComma = search.includes(',')

  const filtered = useMemo(() => {
    if (hasComma) return []
    // Parse priority patterns into individual items, shown first
    const priorityItems: { value: string; type: 'priority' }[] = []
    if (priorityPatterns) {
      const seen = new Set<string>()
      for (const p of priorityPatterns.split(',')) {
        const trimmed = p.trim()
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed)
          priorityItems.push({ value: trimmed, type: 'priority' as const })
        }
      }
    }
    const priorityValues = new Set(priorityItems.map(p => p.value.toLowerCase()))
    const searchItems = [
      ...suggestions.hashtags.filter(h => !priorityValues.has(h.toLowerCase())).map(h => ({ value: h, type: 'tag' as const })),
      ...suggestions.domains.filter(d => !priorityValues.has(d.toLowerCase())).map(d => ({ value: d, type: 'domain' as const })),
    ]
    const all = [...priorityItems, ...searchItems]
    if (!search) return all.slice(0, 10)
    const lower = search.toLowerCase()
    return all.filter(item => item.value.toLowerCase().includes(lower)).slice(0, 10)
  }, [suggestions, search, hasComma, priorityPatterns])

  const handleSelect = useCallback((pattern: string) => {
    setSearch(pattern)
    onChange(pattern)
    setOpen(false)
    setHighlightIndex(-1)
  }, [onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown') {
        setOpen(true)
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      setHighlightIndex(i => Math.min(i + 1, filtered.length - 1))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setHighlightIndex(i => Math.max(i - 1, 0))
      e.preventDefault()
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      handleSelect(filtered[highlightIndex].value)
      e.preventDefault()
    } else if (e.key === 'Escape') {
      setOpen(false)
      setHighlightIndex(-1)
    }
  }, [open, highlightIndex, filtered, handleSelect])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (
        inputRef.current && !inputRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
        setHighlightIndex(-1)
        if (search !== value) onChange(search)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, search, value, onChange])

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
          setHighlightIndex(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setTimeout(() => {
            if (search !== value) onChange(search)
          }, 150)
        }}
        onKeyDown={handleKeyDown}
        placeholder="topic(s)"
        className="w-full px-3 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
      />
      {open && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto"
        >
          {filtered.map((item, i) => (
            <button
              key={item.value}
              type="button"
              className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 dark:hover:bg-gray-700 ${
                i === highlightIndex ? 'bg-blue-50 dark:bg-gray-700' : ''
              }`}
              onMouseDown={(e) => {
                e.preventDefault()
                handleSelect(item.value)
              }}
            >
              <span className={
                item.type === 'priority' ? 'text-orange-600 dark:text-orange-400' :
                item.type === 'tag' ? 'text-blue-600 dark:text-blue-400' : ''
              }>
                {item.value}
              </span>
              <span className="ml-2 text-xs text-gray-400">{item.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Inline Pattern Form (for add-user and edit-users) ---

function InlinePatternForm({
  initial,
  follows,
  suggestions,
  onSave,
  onCancel,
}: {
  initial?: { handle: string; textPattern: string }
  follows: FollowInfo[]
  suggestions?: TextSuggestions
  onSave: (handle: string, textPattern: string) => void
  onCancel: () => void
}) {
  const [handle, setHandle] = useState(initial?.handle || '')
  const [textPattern, setTextPattern] = useState(initial?.textPattern || '')
  const [error, setError] = useState('')

  const handleSave = () => {
    const h = handle.trim()
    const t = textPattern.trim()
    // Both blank is not allowed
    if (!h && !t) {
      setError('Handle or topics required')
      return
    }
    // Standalone * not allowed in topics (blank topics implicitly match all)
    const topicWords = t.split(',').map(w => w.trim())
    if (topicWords.some(w => w === '*')) {
      setError('Use blank topics instead of *')
      return
    }
    // Blank handle with topics → wildcard (stored as blank, serialized as @*)
    onSave(h, t)
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 py-1.5 px-3 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
        <span className="text-gray-500 dark:text-gray-400 text-sm flex-shrink-0">@</span>
        <div className="flex-[3] min-w-0">
          <HandleAutocomplete
            value={handle}
            follows={follows}
            onChange={(v) => { setHandle(v); setError('') }}
            placeholder="handle (blank = any)"
          />
        </div>
        <span className="text-gray-400 dark:text-gray-500 text-sm flex-shrink-0">:</span>
        {suggestions ? (
          <div className="flex-[2] min-w-0">
            <TextPatternAutocomplete
              value={textPattern}
              onChange={(v) => { setTextPattern(v); setError('') }}
              suggestions={suggestions}
              priorityPatterns={follows.find(f => f.username === handle)?.priorityPatterns}
            />
          </div>
        ) : (
          <input
            type="text"
            value={textPattern}
            onChange={(e) => { setTextPattern(e.target.value); setError('') }}
            placeholder="topic(s)"
            className="flex-[2] min-w-0 px-3 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
          />
        )}
        <button
          type="button"
          onClick={handleSave}
          className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-gray-600 dark:text-gray-400 rounded text-xs hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 px-3">{error}</p>}
    </div>
  )
}

// --- Inline Section Form ---

function InlineSectionForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: string
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial || '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex items-center gap-2 py-1.5 px-3 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
      <span className="text-sm text-gray-600 dark:text-gray-400">Section:</span>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) onSave(name.trim())
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Section Name"
        className="flex-1 px-3 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
      />
      <button
        type="button"
        onClick={() => { if (name.trim()) onSave(name.trim()) }}
        className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="px-2 py-1 text-gray-600 dark:text-gray-400 rounded text-xs hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        Cancel
      </button>
    </div>
  )
}

// --- Inline Edition Form ---

function InlineEditionForm({
  initialTime,
  initialName,
  usedTimes,
  onSave,
  onCancel,
}: {
  initialTime?: string
  initialName?: string
  usedTimes?: Set<string>
  onSave: (time: string, name: string) => void
  onCancel: () => void
}) {
  const [time, setTime] = useState(initialTime || '')
  const [name, setName] = useState(initialName || '')

  return (
    <div className="flex items-center gap-2 py-1.5 px-3 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
      <span className="text-sm text-gray-600 dark:text-gray-400">Time:</span>
      <select
        value={time}
        onChange={(e) => setTime(e.target.value)}
        className="px-2 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
      >
        <option value="">--:--</option>
        {TIME_OPTIONS.map(t => {
          const isUsed = usedTimes?.has(t) && t !== initialTime
          return <option key={t} value={t} disabled={isUsed}>{t}{isUsed ? ' (in use)' : ''}</option>
        })}
      </select>
      <span className="text-sm text-gray-600 dark:text-gray-400">Name:</span>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && time) onSave(time, name.trim())
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Edition Name"
        className="flex-1 px-3 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
      />
      <button
        type="button"
        onClick={() => { if (time) onSave(time, name.trim()) }}
        className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="px-2 py-1 text-gray-600 dark:text-gray-400 rounded text-xs hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        Cancel
      </button>
    </div>
  )
}

// --- Plus Button with optional menu ---

function PlusButton({
  onClick,
}: {
  onClick: () => void
}) {
  return (
    <div className="relative flex items-center py-0.5 group">
      <button
        type="button"
        onClick={onClick}
        className="text-gray-300 dark:text-gray-600 hover:text-blue-500 dark:hover:text-blue-400 text-sm font-bold w-5 h-5 flex items-center justify-center rounded transition-colors"
        title="Add here"
      >
        +
      </button>
    </div>
  )
}

// --- Newspaper Display Components ---

function NewspaperPatternLine({
  pattern,
  displayNameMap,
  mode,
  editingId,
  follows,
  suggestions,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  fontClass,
}: {
  pattern: EditorPattern
  displayNameMap: Map<string, string>
  mode: EditorMode
  editingId: string | null
  follows: FollowInfo[]
  suggestions?: TextSuggestions
  onStartEdit: () => void
  onSaveEdit: (handle: string, textPattern: string) => void
  onCancelEdit: () => void
  onDelete: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  fontClass: string
}) {
  const isEditing = editingId === pattern.id

  if (isEditing) {
    return (
      <InlinePatternForm
        initial={{ handle: pattern.handle, textPattern: pattern.textPattern }}
        follows={follows}
        suggestions={suggestions}
        onSave={onSaveEdit}
        onCancel={onCancelEdit}
      />
    )
  }

  const isWildcard = !pattern.handle || pattern.handle === '*'
  const displayName = isWildcard ? undefined : displayNameMap.get(pattern.handle)

  return (
    <div className="flex items-center group py-0.5">
      <div className={`flex-1 ${fontClass} text-base text-gray-800 dark:text-gray-200`}>
        {isWildcard ? (
          <span className="text-gray-400 dark:text-gray-500 italic">any user</span>
        ) : displayName ? (
          <>
            <span>{displayName}</span>
            <span className="text-sm text-gray-400 dark:text-gray-500 italic ml-1">
              (@{pattern.handle})
            </span>
          </>
        ) : (
          <span>@{pattern.handle}</span>
        )}
        {pattern.textPattern && (
          <span className="text-gray-600 dark:text-gray-400">
            : {pattern.textPattern}
          </span>
        )}
      </div>

      {mode === 'edit-users' && (
        <div className="flex items-center gap-0.5 ml-2">
          {onMoveUp && (
            <button type="button" onClick={onMoveUp} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs px-1" title="Move up">▲</button>
          )}
          {onMoveDown && (
            <button type="button" onClick={onMoveDown} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs px-1" title="Move down">▼</button>
          )}
          <button type="button" onClick={onStartEdit} className="text-gray-400 hover:text-blue-500 text-sm px-1" title="Edit"><PencilIcon className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={onDelete} className="text-gray-400 hover:text-red-500 text-sm px-1" title="Delete"><TrashIcon className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </div>
  )
}

function NewspaperSection({
  section,
  edition: _edition,
  isDefault,
  displayNameMap,
  mode,
  editingId,
  follows,
  suggestionsByHandle,
  insertPoint,
  onSetInsertPoint,
  onAddPattern,
  onImportList,
  lists,
  loadingLists,
  importingList,
  onSelectList,
  onCancelListPicker,
  onStartEditPattern,
  onSaveEditPattern,
  onCancelEdit,
  onDeletePattern,
  onMovePattern,
  editingSectionId,
  onStartEditSection,
  onSaveEditSection,
  onCancelEditSection,
  onDeleteSection,
  onMoveSection: _onMoveSection,
  onMoveSectionUp,
  onMoveSectionDown,
  fontClass,
}: {
  section: EditorSection
  edition: EditorEdition
  isDefault: boolean
  displayNameMap: Map<string, string>
  mode: EditorMode
  editingId: string | null
  follows: FollowInfo[]
  suggestionsByHandle?: SuggestionsMap
  insertPoint: string | null  // afterPatternId or 'top' for insert at top
  onSetInsertPoint: (point: string | null) => void
  onAddPattern: (afterPatternId: string | null, handle: string, textPattern: string) => void
  onImportList: () => void
  lists: { uri: string; name: string }[]
  loadingLists: boolean
  importingList: boolean
  onSelectList: (listUri: string, listName: string) => void
  onCancelListPicker: () => void
  onStartEditPattern: (patternId: string) => void
  onSaveEditPattern: (patternId: string, handle: string, textPattern: string) => void
  onCancelEdit: () => void
  onDeletePattern: (patternId: string) => void
  onMovePattern: (patternId: string, direction: -1 | 1) => void
  editingSectionId: string | null
  onStartEditSection: () => void
  onSaveEditSection: (name: string) => void
  onCancelEditSection: () => void
  onDeleteSection: () => void
  onMoveSection?: () => void
  onMoveSectionUp?: () => void
  onMoveSectionDown?: () => void
  fontClass: string
}) {
  const showPatterns = mode !== 'add-section' && mode !== 'edit-sections' && mode !== 'edit-editions'
  const showSectionControls = mode === 'edit-sections'
  const isEditingThisSection = editingSectionId === section.id

  // Section heading
  const sectionHeading = !isDefault && section.name && (
    <div className="flex items-center mt-3 mb-1">
      {isEditingThisSection ? (
        <InlineSectionForm
          initial={section.name}
          onSave={onSaveEditSection}
          onCancel={onCancelEditSection}
        />
      ) : (
        <>
          {mode !== 'view' && (
            <span className="text-gray-400 dark:text-gray-500 text-xs mr-1.5 flex-shrink-0">
              {showPatterns ? '▼' : '▶'}
            </span>
          )}
          <h3 className={`${fontClass} text-base font-semibold text-gray-700 dark:text-gray-300 tracking-wide flex-1`}>
            {section.name}
          </h3>
          {showSectionControls && (
            <div className="flex items-center gap-0.5 ml-2">
              {onMoveSectionUp && (
                <button type="button" onClick={onMoveSectionUp} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs px-1" title="Move up">▲</button>
              )}
              {onMoveSectionDown && (
                <button type="button" onClick={onMoveSectionDown} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs px-1" title="Move down">▼</button>
              )}
              <button type="button" onClick={onStartEditSection} className="text-gray-400 hover:text-blue-500 text-sm px-1" title="Edit"><PencilIcon className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={onDeleteSection} className="text-gray-400 hover:text-red-500 text-sm px-1" title="Delete"><TrashIcon className="w-3.5 h-3.5" /></button>
            </div>
          )}
        </>
      )}
    </div>
  )

  // For add-section mode, just show the heading (no patterns)
  if (!showPatterns) {
    return <>{sectionHeading}</>
  }

  const renderPlusButton = (afterPatternId: string | null) => {
    if (mode !== 'add-user' && mode !== 'import-list') return null
    // Prefix with section ID to avoid collisions when multiple sections share the same pointKey (e.g., 'top')
    const pointKey = `${section.id}:${afterPatternId || 'top'}`
    const isActive = insertPoint === pointKey

    // In add-user mode, show inline pattern form when active
    if (mode === 'add-user' && isActive) {
      return (
        <InlinePatternForm
          follows={follows}
          suggestions={undefined}
          onSave={(handle, textPattern) => {
            onAddPattern(afterPatternId, handle, textPattern)
            onSetInsertPoint(null)
          }}
          onCancel={() => onSetInsertPoint(null)}
        />
      )
    }

    // In import-list mode, show inline list picker only at the exact + that was clicked
    if (mode === 'import-list' && isActive) {
      return (
        <div className="flex items-center gap-2 py-1 ml-5">
          {loadingLists || importingList ? (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {importingList ? 'Importing...' : 'Loading lists...'}
            </span>
          ) : lists.length === 0 ? (
            <>
              <span className="text-sm text-gray-500 dark:text-gray-400">No lists found</span>
              <button
                type="button"
                onClick={onCancelListPicker}
                className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 border border-gray-300 dark:border-gray-600 rounded"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <select
                onChange={(e) => {
                  if (e.target.value) {
                    const list = lists.find(l => l.uri === e.target.value)
                    if (list) onSelectList(list.uri, list.name)
                  }
                }}
                defaultValue=""
                className="px-2 py-1 border rounded text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
              >
                <option value="" disabled>Select a list...</option>
                {lists.map(list => (
                  <option key={list.uri} value={list.uri}>{list.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={onCancelListPicker}
                className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 border border-gray-300 dark:border-gray-600 rounded"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )
    }

    return (
      <PlusButton
        onClick={() => {
          if (mode === 'add-user') {
            onSetInsertPoint(pointKey)
          } else if (mode === 'import-list') {
            onSetInsertPoint(pointKey)
            onImportList()
          }
        }}
      />
    )
  }

  return (
    <div>
      {sectionHeading}

      {/* Plus at top of section */}
      {renderPlusButton(null)}

      {section.patterns.map((pattern, idx) => (
        <div key={pattern.id}>
          <NewspaperPatternLine
            pattern={pattern}
            displayNameMap={displayNameMap}
            mode={mode}
            editingId={editingId}
            follows={follows}
            suggestions={suggestionsByHandle?.get(pattern.handle)}
            onStartEdit={() => onStartEditPattern(pattern.id)}
            onSaveEdit={(handle, textPattern) => onSaveEditPattern(pattern.id, handle, textPattern)}
            onCancelEdit={onCancelEdit}
            onDelete={() => onDeletePattern(pattern.id)}
            onMoveUp={idx > 0 ? () => onMovePattern(pattern.id, -1) : undefined}
            onMoveDown={idx < section.patterns.length - 1 ? () => onMovePattern(pattern.id, 1) : undefined}
            fontClass={fontClass}
          />
          {renderPlusButton(pattern.id)}
        </div>
      ))}
    </div>
  )
}

function NewspaperEdition({
  edition,
  displayNameMap,
  mode,
  editingId,
  editingSectionId,
  editingEditionId,
  follows,
  suggestionsByHandle,
  usedTimes,
  insertPoint,
  insertEditionId,
  sectionInsertPoint,
  sectionInsertEditionId,
  onSetInsertPoint,
  onSetSectionInsertPoint,
  onAddPattern,
  onImportList,
  lists,
  loadingLists,
  importingList,
  onSelectList,
  onCancelListPicker,
  onStartEditPattern,
  onSaveEditPattern,
  onCancelEditPattern,
  onDeletePattern,
  onMovePattern,
  onStartEditSection,
  onSaveEditSection,
  onCancelEditSection,
  onDeleteSection,
  onMoveSection,
  onAddSection,
  onStartEditEdition,
  onSaveEditEdition,
  onCancelEditEdition,
  onDeleteEdition,
  fontClass,
}: {
  edition: EditorEdition
  displayNameMap: Map<string, string>
  mode: EditorMode
  editingId: string | null
  editingSectionId: string | null
  editingEditionId: string | null
  follows: FollowInfo[]
  suggestionsByHandle?: SuggestionsMap
  usedTimes: Set<string>
  insertPoint: string | null
  insertEditionId: string | null
  sectionInsertPoint: string | null
  sectionInsertEditionId: string | null
  onSetInsertPoint: (editionId: string, point: string | null) => void
  onSetSectionInsertPoint: (editionId: string, point: string | null) => void
  onAddPattern: (editionId: string, sectionId: string, afterPatternId: string | null, handle: string, textPattern: string) => void
  onImportList: () => void
  lists: { uri: string; name: string }[]
  loadingLists: boolean
  importingList: boolean
  onSelectList: (listUri: string, listName: string) => void
  onCancelListPicker: () => void
  onStartEditPattern: (patternId: string) => void
  onSaveEditPattern: (editionId: string, sectionId: string, patternId: string, handle: string, textPattern: string) => void
  onCancelEditPattern: () => void
  onDeletePattern: (editionId: string, sectionId: string, patternId: string) => void
  onMovePattern: (editionId: string, sectionId: string, patternId: string, direction: -1 | 1) => void
  onStartEditSection: (sectionId: string) => void
  onSaveEditSection: (editionId: string, sectionId: string, name: string) => void
  onCancelEditSection: () => void
  onDeleteSection: (editionId: string, sectionId: string) => void
  onMoveSection: (editionId: string, sectionId: string, direction: -1 | 1) => void
  onAddSection: (editionId: string, afterSectionId: string | null) => void
  onStartEditEdition: () => void
  onSaveEditEdition: (time: string, name: string) => void
  onCancelEditEdition: () => void
  onDeleteEdition: () => void
  fontClass: string
}) {
  const isCommonOrTail = edition.type === 'common' || edition.type === 'tail'
  const showSections = mode !== 'edit-editions'
  const isEditingThisEdition = editingEditionId === edition.id

  // Edition headline
  const editionHeadline = (() => {
    if (isEditingThisEdition) {
      return (
        <InlineEditionForm
          initialTime={edition.time}
          initialName={edition.name}
          usedTimes={usedTimes}
          onSave={onSaveEditEdition}
          onCancel={onCancelEditEdition}
        />
      )
    }

    const showAccordion = mode !== 'view'
    // Read-only indicator: ▶ when sections hidden (edit-editions), ▼ when shown
    const accordionIndicator = showAccordion ? (
      <span className="text-gray-400 dark:text-gray-500 text-xs mr-1.5 flex-shrink-0">
        {showSections ? '▼' : '▶'}
      </span>
    ) : null

    if (isCommonOrTail) {
      return (
        <div className="flex items-center py-2">
          {accordionIndicator}
          <h2 className={`${fontClass} text-base text-gray-400 dark:text-gray-500 flex-1`}>
            {edition.name}
          </h2>
        </div>
      )
    }

    return (
      <div className="flex items-center py-2 border-b-2 border-gray-800 dark:border-gray-300 mb-2">
        {accordionIndicator}
        <h2 className={`${fontClass} text-xl font-bold text-gray-900 dark:text-gray-100 flex-1`}>
          {edition.name || 'Untitled Edition'}
        </h2>
        <span className="text-sm text-gray-400 dark:text-gray-500 ml-4 flex-shrink-0">
          {edition.time}
        </span>
        {mode === 'edit-editions' && (
          <div className="flex items-center gap-0.5 ml-2">
            <button type="button" onClick={onStartEditEdition} className="text-gray-400 hover:text-blue-500 text-sm px-1" title="Edit"><PencilIcon className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={onDeleteEdition} className="text-gray-400 hover:text-red-500 text-sm px-1" title="Delete"><TrashIcon className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>
    )
  })()

  if (!showSections) {
    return <div className="mb-4">{editionHeadline}</div>
  }

  // Section insert plus
  const renderSectionPlus = (afterSectionId: string | null) => {
    if (mode !== 'add-section') return null
    const pointKey = afterSectionId || 'top'
    const isActive = sectionInsertEditionId === edition.id && sectionInsertPoint === pointKey

    if (isActive) {
      return (
        <InlineSectionForm
          onSave={(name) => {
            onAddSection(edition.id, afterSectionId)
            // The add will be done with the name from the form
            // We need a different approach - save name directly
            onSaveEditSection(edition.id, '__new__', name)
            onSetSectionInsertPoint(edition.id, null)
          }}
          onCancel={() => onSetSectionInsertPoint(edition.id, null)}
        />
      )
    }

    return (
      <div className="py-0.5">
        <button
          type="button"
          onClick={() => onSetSectionInsertPoint(edition.id, pointKey)}
          className="text-gray-300 dark:text-gray-600 hover:text-blue-500 dark:hover:text-blue-400 text-sm font-bold w-5 h-5 flex items-center justify-center rounded transition-colors"
          title="Add section here"
        >
          +
        </button>
      </div>
    )
  }

  return (
    <div className="mb-6">
      {editionHeadline}

      {/* Only show top + if first section is named (otherwise it duplicates the + after the default section) */}
      {edition.sections.length === 0 || edition.sections[0].name !== '' ? renderSectionPlus(null) : null}

      {edition.sections.map((section, sIdx) => (
        <div key={section.id}>
          <NewspaperSection
            section={section}
            edition={edition}
            isDefault={section.name === '' && sIdx === 0}
            displayNameMap={displayNameMap}
            mode={mode}
            editingId={editingId}
            follows={follows}
            suggestionsByHandle={suggestionsByHandle}
            insertPoint={insertEditionId === edition.id ? insertPoint : null}
            onSetInsertPoint={(point) => onSetInsertPoint(edition.id, point)}
            onAddPattern={(afterPatternId, handle, textPattern) =>
              onAddPattern(edition.id, section.id, afterPatternId, handle, textPattern)
            }
            onImportList={onImportList}
            lists={lists}
            loadingLists={loadingLists}
            importingList={importingList}
            onSelectList={onSelectList}
            onCancelListPicker={onCancelListPicker}
            onStartEditPattern={onStartEditPattern}
            onSaveEditPattern={(patternId, handle, textPattern) =>
              onSaveEditPattern(edition.id, section.id, patternId, handle, textPattern)
            }
            onCancelEdit={onCancelEditPattern}
            onDeletePattern={(patternId) => onDeletePattern(edition.id, section.id, patternId)}
            onMovePattern={(patternId, direction) => onMovePattern(edition.id, section.id, patternId, direction)}
            editingSectionId={editingSectionId}
            onStartEditSection={() => onStartEditSection(section.id)}
            onSaveEditSection={(name) => onSaveEditSection(edition.id, section.id, name)}
            onCancelEditSection={onCancelEditSection}
            onDeleteSection={() => onDeleteSection(edition.id, section.id)}
            onMoveSectionUp={sIdx > 1 || (sIdx > 0 && edition.sections[0].name !== '') ? () => onMoveSection(edition.id, section.id, -1) : undefined}
            onMoveSectionDown={sIdx < edition.sections.length - 1 ? () => onMoveSection(edition.id, section.id, 1) : undefined}
            fontClass={fontClass}
          />
          {renderSectionPlus(section.id)}
        </div>
      ))}
    </div>
  )
}

// --- Editor Toolbar ---

function EditorToolbar({
  mode,
  onModeChange,
  suggestTextPatterns,
  onSuggestTextPatternsChange,
  addEditionTime,
  onAddEditionTimeChange,
  showAddEditionForm,
  onToggleAddEditionForm,
  onAddEdition,
  usedTimes,
  headerContent,
  fontClass,
}: {
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
  suggestTextPatterns: boolean
  onSuggestTextPatternsChange: (checked: boolean) => void
  addEditionTime: string
  onAddEditionTimeChange: (time: string) => void
  showAddEditionForm: boolean
  onToggleAddEditionForm: () => void
  onAddEdition: (time: string, name: string) => void
  usedTimes: Set<string>
  headerContent?: React.ReactNode
  fontClass: string
}) {
  const [addEditionName, setAddEditionName] = useState('')

  const modeButton = (label: string, targetMode: EditorMode, sizeClass = 'text-sm', weightClass = '') => (
    <button
      type="button"
      onClick={() => {
        if (showAddEditionForm) {
          onToggleAddEditionForm()
          setAddEditionName('')
          onAddEditionTimeChange('')
        }
        onModeChange(mode === targetMode ? 'view' : targetMode)
      }}
      className={`${fontClass} px-3 py-1 ${sizeClass} ${weightClass} rounded border transition-colors ${
        mode === targetMode && !(showAddEditionForm && targetMode === 'edit-editions')
          ? 'bg-blue-600 text-white border-blue-600'
          : 'text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-2">
      {/* Header content (Switch to Text Editor button) */}
      <div>{headerContent}</div>

      {/* Line 1: Add edition + Edit editions */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => {
            if (showAddEditionForm) {
              // Cancel: hide form and restore view mode
              onToggleAddEditionForm()
              setAddEditionName('')
              onAddEditionTimeChange('')
              onModeChange('view')
            } else {
              // Open: show form and switch to edit-editions view
              if (mode !== 'edit-editions') onModeChange('edit-editions')
              onToggleAddEditionForm()
            }
          }}
          className={`${fontClass} px-3 py-1 text-lg font-bold rounded border transition-colors ${
            showAddEditionForm
              ? 'bg-blue-600 text-white border-blue-600'
              : 'text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          Add edition
        </button>
        {showAddEditionForm && (
          <>
            <select
              value={addEditionTime}
              onChange={(e) => onAddEditionTimeChange(e.target.value)}
              className="px-2 py-1 border rounded text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
            >
              <option value="">Time...</option>
              {TIME_OPTIONS.map(t => (
                <option key={t} value={t} disabled={usedTimes.has(t)}>{t}{usedTimes.has(t) ? ' (in use)' : ''}</option>
              ))}
            </select>
            <input
              type="text"
              value={addEditionName}
              onChange={(e) => setAddEditionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addEditionTime) {
                  onAddEdition(addEditionTime, addEditionName.trim())
                  setAddEditionName('')
                }
                if (e.key === 'Escape') {
                  onToggleAddEditionForm()
                  setAddEditionName('')
                  onAddEditionTimeChange('')
                  onModeChange('view')
                }
              }}
              placeholder="Edition Name"
              className="px-2 py-1 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 flex-1 min-w-[120px]"
            />
            <button
              type="button"
              onClick={() => {
                if (addEditionTime) {
                  onAddEdition(addEditionTime, addEditionName.trim())
                  setAddEditionName('')
                }
              }}
              disabled={!addEditionTime}
              className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                onToggleAddEditionForm()
                setAddEditionName('')
                onAddEditionTimeChange('')
                onModeChange('view')
              }}
              className="px-2 py-1 text-gray-600 dark:text-gray-400 rounded text-xs hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </>
        )}
        {modeButton('Edit editions', 'edit-editions', 'text-lg', 'font-bold')}
      </div>

      {/* Line 2: Add section + Edit sections */}
      <div className="flex items-center gap-3 ml-4">
        {modeButton('Add section', 'add-section', 'text-base', 'font-semibold')}
        {modeButton('Edit sections', 'edit-sections', 'text-base', 'font-semibold')}
      </div>

      {/* Line 3: Add author + Edit authors + Import Bluesky list + Suggest topics */}
      <div className="flex items-center gap-3 ml-8">
        {modeButton('Add author', 'add-user', 'text-base')}
        {modeButton('Edit authors', 'edit-users', 'text-base')}
        {modeButton('Import Bluesky list', 'import-list', 'text-base')}
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={suggestTextPatterns}
            onChange={(e) => onSuggestTextPatternsChange(e.target.checked)}
            className="rounded"
          />
          Suggest topics
        </label>
      </div>

      {/* Help messages */}
      {mode === 'add-user' && (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic ml-8">
          Click on "+" to add author and topic
        </div>
      )}
      {mode === 'import-list' && (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic ml-8">
          Click on "+" to insert Bluesky list
        </div>
      )}
      {mode === 'add-section' && (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic ml-4">
          Click on "+" to add section
        </div>
      )}
    </div>
  )
}


// --- Main Component ---

interface EditionLayoutEditorProps {
  layoutText: string
  onSave: (text: string) => Promise<void>
  onTextChange?: (text: string) => void
  headerContent?: React.ReactNode
  editionFont?: 'serif' | 'sans-serif'
  readOnly?: boolean
}

export default function EditionLayoutEditor({ layoutText, onSave, onTextChange, headerContent, editionFont = 'serif', readOnly = false }: EditionLayoutEditorProps) {
  const [state, setState] = useState<EditorState>(() => parseLayoutToEditor(layoutText))
  const [follows, setFollows] = useState<FollowInfo[]>([])
  const [suggestTextPatterns, setSuggestTextPatterns] = useState(true)
  const [suggestionsByHandle, setSuggestionsByHandle] = useState<SuggestionsMap>(new Map())
  const initializedRef = useRef(false)
  const internalChangeRef = useRef(false)

  // Mode state
  const [mode, setMode] = useState<EditorMode>('view')
  const [editingId, setEditingId] = useState<string | null>(null) // pattern being edited
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null)
  const [editingEditionId, setEditingEditionId] = useState<string | null>(null)

  // Insert point tracking for add-user mode
  const [insertPoint, setInsertPoint] = useState<string | null>(null)
  const [insertEditionId, setInsertEditionId] = useState<string | null>(null)

  // Section insert tracking for add-section mode
  const [sectionInsertPoint, setSectionInsertPoint] = useState<string | null>(null)
  const [sectionInsertEditionId, setSectionInsertEditionId] = useState<string | null>(null)

  // Add edition form
  const [addEditionTime, setAddEditionTime] = useState('')
  const [showAddEditionForm, setShowAddEditionForm] = useState(false)

  // List import state (reuses insertPoint/insertEditionId for location tracking)
  const { agent } = useSession()
  const [lists, setLists] = useState<{ uri: string; name: string }[]>([])
  const [loadingLists, setLoadingLists] = useState(false)
  const [importingList, setImportingList] = useState(false)

  // Escape key to return to view mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode !== 'view') {
        // Only exit mode if no inline form is open
        if (!editingId && !editingSectionId && !editingEditionId && !insertPoint && !sectionInsertPoint) {
          setMode('view')
        }
        // Close inline forms
        setEditingId(null)
        setEditingSectionId(null)
        setEditingEditionId(null)
        setInsertPoint(null)
        setInsertEditionId(null)
        setSectionInsertPoint(null)
        setSectionInsertEditionId(null)
        setLists([])
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mode, editingId, editingSectionId, editingEditionId, insertPoint, sectionInsertPoint])

  // Reset inline state when mode changes
  useEffect(() => {
    setEditingId(null)
    setEditingSectionId(null)
    setEditingEditionId(null)
    setInsertPoint(null)
    setInsertEditionId(null)
    setSectionInsertPoint(null)
    setSectionInsertEditionId(null)
    setLists([])
  }, [mode])

  // Load follows for autocomplete
  useEffect(() => {
    getAllFollows().then(allFollows => {
      const realFollows = allFollows
        .filter(f => !f.username.startsWith('editor_'))
        .sort((a, b) => a.username.localeCompare(b.username))
      setFollows(realFollows)
    })
  }, [])

  // Load pre-computed text pattern suggestions
  useEffect(() => {
    if (!suggestTextPatterns) {
      setSuggestionsByHandle(new Map())
      return
    }
    getTextSuggestions().then(suggestions => {
      setSuggestionsByHandle(suggestions || new Map())
    })
  }, [suggestTextPatterns])

  // Re-parse when layoutText changes externally
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      return
    }
    if (internalChangeRef.current) {
      internalChangeRef.current = false
      return
    }
    setState(parseLayoutToEditor(layoutText))
  }, [layoutText])

  // Build display name map
  const displayNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of follows) {
      if (f.displayName) {
        map.set(f.username, f.displayName)
      }
    }
    return map
  }, [follows])

  // --- State Update Helpers ---

  const findEditionAndApply = (editionId: string, updater: (edition: EditorEdition) => EditorEdition) => {
    const editions = state.editions.map(e =>
      e.id === editionId ? updater(e) : e
    )
    // Re-sort timed editions by time
    const common = editions.filter(e => e.type === 'common')
    const timed = editions.filter(e => e.type === 'timed')
    const tail = editions.filter(e => e.type === 'tail')
    timed.sort((a, b) => a.time.localeCompare(b.time))
    setState({ ...state, editions: [...common, ...timed, ...tail] })
  }

  const addPatternToSection = (editionId: string, sectionId: string, afterPatternId: string | null, handle: string, textPattern: string) => {
    const newPattern: EditorPattern = { id: makeId(), handle, textPattern }
    findEditionAndApply(editionId, edition => ({
      ...edition,
      sections: edition.sections.map(s => {
        if (s.id !== sectionId) return s
        const patterns = [...s.patterns]
        if (!afterPatternId) {
          patterns.unshift(newPattern)
        } else {
          const idx = patterns.findIndex(p => p.id === afterPatternId)
          patterns.splice(idx + 1, 0, newPattern)
        }
        return { ...s, patterns }
      })
    }))
  }

  const updatePatternInSection = (editionId: string, sectionId: string, patternId: string, handle: string, textPattern: string) => {
    findEditionAndApply(editionId, edition => ({
      ...edition,
      sections: edition.sections.map(s => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          patterns: s.patterns.map(p =>
            p.id === patternId ? { ...p, handle, textPattern } : p
          )
        }
      })
    }))
    setEditingId(null)
  }

  const deletePatternFromSection = (editionId: string, sectionId: string, patternId: string) => {
    if (!window.confirm('Delete this user entry?')) return
    findEditionAndApply(editionId, edition => ({
      ...edition,
      sections: edition.sections.map(s => {
        if (s.id !== sectionId) return s
        return { ...s, patterns: s.patterns.filter(p => p.id !== patternId) }
      })
    }))
  }

  const movePatternInSection = (editionId: string, sectionId: string, patternId: string, direction: -1 | 1) => {
    findEditionAndApply(editionId, edition => ({
      ...edition,
      sections: edition.sections.map(s => {
        if (s.id !== sectionId) return s
        const patterns = [...s.patterns]
        const idx = patterns.findIndex(p => p.id === patternId)
        const targetIdx = idx + direction
        if (targetIdx < 0 || targetIdx >= patterns.length) return s
        ;[patterns[idx], patterns[targetIdx]] = [patterns[targetIdx], patterns[idx]]
        return { ...s, patterns }
      })
    }))
  }

  const addSectionToEdition = (editionId: string, afterSectionId: string | null, name: string) => {
    const newSection: EditorSection = { id: makeId(), name, patterns: [], collapsed: false }
    findEditionAndApply(editionId, edition => {
      const sections = [...edition.sections]
      if (!afterSectionId) {
        // Insert after default section (index 0) if it exists
        if (sections.length > 0 && sections[0].name === '') {
          sections.splice(1, 0, newSection)
        } else {
          sections.unshift(newSection)
        }
      } else {
        const idx = sections.findIndex(s => s.id === afterSectionId)
        sections.splice(idx + 1, 0, newSection)
      }
      return { ...edition, sections }
    })
  }

  const updateSectionInEdition = (editionId: string, sectionId: string, name: string) => {
    findEditionAndApply(editionId, edition => ({
      ...edition,
      sections: edition.sections.map(s =>
        s.id === sectionId ? { ...s, name } : s
      )
    }))
    setEditingSectionId(null)
  }

  const deleteSectionFromEdition = (editionId: string, sectionId: string) => {
    if (!window.confirm('Delete this section and all its users?')) return
    findEditionAndApply(editionId, edition => ({
      ...edition,
      sections: edition.sections.filter(s => s.id !== sectionId)
    }))
  }

  const moveSectionInEdition = (editionId: string, sectionId: string, direction: -1 | 1) => {
    findEditionAndApply(editionId, edition => {
      const sections = [...edition.sections]
      const idx = sections.findIndex(s => s.id === sectionId)
      const targetIdx = idx + direction
      if (targetIdx < 0 || targetIdx >= sections.length) return edition
      ;[sections[idx], sections[targetIdx]] = [sections[targetIdx], sections[idx]]
      return { ...edition, sections }
    })
  }

  const addEdition = (time: string, name: string) => {
    const newEdition: EditorEdition = {
      id: makeId(),
      type: 'timed',
      time,
      name,
      sections: [{ id: makeId(), name: '', patterns: [], collapsed: false }],
      collapsed: false,
    }
    const common = state.editions.filter(e => e.type === 'common')
    const timed = [...state.editions.filter(e => e.type === 'timed'), newEdition]
    const tail = state.editions.filter(e => e.type === 'tail')
    timed.sort((a, b) => a.time.localeCompare(b.time))
    setState({ ...state, editions: [...common, ...timed, ...tail] })
    setAddEditionTime('')
    setShowAddEditionForm(false)
  }

  const updateEdition = (editionId: string, time: string, name: string) => {
    findEditionAndApply(editionId, edition => ({
      ...edition,
      time,
      name,
    }))
    setEditingEditionId(null)
  }

  const deleteEdition = (editionId: string) => {
    if (!window.confirm('Delete this edition and all its contents?')) return
    setState({
      ...state,
      editions: state.editions.filter(e => e.id !== editionId)
    })
  }

  // List import handler — reuses insertPoint/insertEditionId for location tracking
  const handleImportList = async () => {
    if (!agent) return
    setLoadingLists(true)
    try {
      const userLists = await getUserLists(agent)
      setLists(userLists)
    } catch (err) {
      alert(`Failed to fetch lists: ${err instanceof Error ? err.message : 'Unknown error'}`)
      setInsertPoint(null)
      setInsertEditionId(null)
    } finally {
      setLoadingLists(false)
    }
  }

  const handleCancelListPicker = () => {
    setInsertPoint(null)
    setInsertEditionId(null)
    setLists([])
  }

  const handleSelectList = async (listUri: string, listName: string) => {
    if (!agent || !insertEditionId || !insertPoint) return
    // Extract sectionId from insertPoint (format: "sectionId:afterPatternId")
    const sectionId = insertPoint.split(':')[0]
    setImportingList(true)
    try {
      const handles = await getListMembers(agent, listUri)
      if (handles.length === 0) {
        alert(`No members found in "${listName}".`)
        setInsertPoint(null)
        setInsertEditionId(null)
        setImportingList(false)
        return
      }

      const followedHandles = new Set(follows.map(f => f.username))
      const unfollowedCount = handles.filter(h => !followedHandles.has(h)).length

      if (unfollowedCount > 0 || handles.length > 10) {
        let message = `Import ${handles.length} users from "${listName}"?`
        if (unfollowedCount > 0) {
          message += `\n\nThere are ${unfollowedCount} unfollowed users in the list. You will need to follow them for their posts to be included in editions.`
        }
        if (!window.confirm(message)) {
          setInsertPoint(null)
          setInsertEditionId(null)
          setImportingList(false)
          return
        }
      }

      const newPatterns: EditorPattern[] = handles.map(handle => ({
        id: makeId(),
        handle,
        textPattern: '',
      }))

      findEditionAndApply(insertEditionId, edition => ({
        ...edition,
        sections: edition.sections.map(s => {
          if (s.id !== sectionId) return s
          return { ...s, patterns: [...s.patterns, ...newPatterns] }
        })
      }))

      setInsertPoint(null)
      setInsertEditionId(null)
    } catch (err) {
      alert(`Failed to import list: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setImportingList(false)
    }
  }

  const handleSave = async () => {
    const text = generateLayoutText(state)
    await onSave(text)
  }

  // Sync editor state to parent whenever it changes
  useEffect(() => {
    if (!initializedRef.current) return
    if (onTextChange) {
      internalChangeRef.current = true
      const text = generateLayoutText(state)
      onTextChange(text)
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

  // Deduplicate warnings
  const uniqueWarnings = [...new Set(state.warnings)]
    .filter(w => !w.includes('at least one user/topic'))

  const activeSuggestions = suggestTextPatterns ? suggestionsByHandle : undefined

  return (
    <div className="space-y-4">
        <>
          {/* Toolbar (hidden in readOnly mode) */}
          {readOnly ? (
            <div>{headerContent}</div>
          ) : (
            <EditorToolbar
              mode={mode}
              onModeChange={setMode}
              suggestTextPatterns={suggestTextPatterns}
              onSuggestTextPatternsChange={setSuggestTextPatterns}
              addEditionTime={addEditionTime}
              onAddEditionTimeChange={setAddEditionTime}
              showAddEditionForm={showAddEditionForm}
              onToggleAddEditionForm={() => setShowAddEditionForm(!showAddEditionForm)}
              onAddEdition={addEdition}
              usedTimes={new Set(state.editions.filter(e => e.type === 'timed').map(e => e.time))}
              headerContent={headerContent}
              fontClass={editionFont === 'sans-serif' ? 'font-newspaper-sans' : 'font-serif'}
            />
          )}

          {/* Warnings */}
          {uniqueWarnings.length > 0 && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200 p-3 rounded-lg text-sm">
              <div className="font-medium mb-1">Notes:</div>
              <ul className="list-disc list-inside space-y-0.5">
                {uniqueWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Newspaper Layout */}
          <div className="max-w-2xl rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-4 shadow-sm" style={{ boxShadow: 'inset 0 0 12px 2px rgba(180, 160, 120, 0.12), 0 1px 3px 0 rgba(0, 0, 0, 0.05)' }}>
            {state.editions.map((edition) => (
              <NewspaperEdition
                key={edition.id}
                edition={edition}
                displayNameMap={displayNameMap}
                mode={mode}
                editingId={editingId}
                editingSectionId={editingSectionId}
                editingEditionId={editingEditionId}
                follows={follows}
                suggestionsByHandle={activeSuggestions}
                usedTimes={new Set(state.editions.filter(e => e.type === 'timed').map(e => e.time))}
                insertPoint={insertPoint}
                insertEditionId={insertEditionId}
                sectionInsertPoint={sectionInsertPoint}
                sectionInsertEditionId={sectionInsertEditionId}
                onSetInsertPoint={(edId, point) => { setInsertEditionId(edId); setInsertPoint(point) }}
                onSetSectionInsertPoint={(edId, point) => { setSectionInsertEditionId(edId); setSectionInsertPoint(point) }}
                onAddPattern={addPatternToSection}
                onImportList={handleImportList}
                lists={lists}
                loadingLists={loadingLists}
                importingList={importingList}
                onSelectList={handleSelectList}
                onCancelListPicker={handleCancelListPicker}
                onStartEditPattern={(patternId) => setEditingId(patternId)}
                onSaveEditPattern={updatePatternInSection}
                onCancelEditPattern={() => setEditingId(null)}
                onDeletePattern={deletePatternFromSection}
                onMovePattern={movePatternInSection}
                onStartEditSection={(sectionId) => setEditingSectionId(sectionId)}
                onSaveEditSection={(editionId, sectionId, name) => {
                  if (sectionId === '__new__') {
                    // Adding new section - find the insert point
                    const afterSectionId = sectionInsertPoint === 'top' ? null : sectionInsertPoint
                    addSectionToEdition(editionId, afterSectionId, name)
                    setSectionInsertPoint(null)
                    setSectionInsertEditionId(null)
                  } else {
                    updateSectionInEdition(editionId, sectionId, name)
                  }
                }}
                onCancelEditSection={() => {
                  setEditingSectionId(null)
                  setSectionInsertPoint(null)
                  setSectionInsertEditionId(null)
                }}
                onDeleteSection={deleteSectionFromEdition}
                onMoveSection={moveSectionInEdition}
                onAddSection={(editionId, afterSectionId) => {
                  setSectionInsertEditionId(editionId)
                  setSectionInsertPoint(afterSectionId || 'top')
                }}
                onStartEditEdition={() => setEditingEditionId(edition.id)}
                onSaveEditEdition={(time, name) => updateEdition(edition.id, time, name)}
                onCancelEditEdition={() => setEditingEditionId(null)}
                onDeleteEdition={() => deleteEdition(edition.id)}
                fontClass={editionFont === 'sans-serif' ? 'font-newspaper-sans' : 'font-serif'}
              />
            ))}
          </div>

          {/* Save button (hidden in readOnly mode) */}
          {!readOnly && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
            >
              Save Edition Layout
            </button>
          </div>
          )}

        </>
    </div>
  )
}
