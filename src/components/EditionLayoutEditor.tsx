/**
 * Visual editor for simplified edition layouts.
 *
 * Supports: timed editions with sections and patterns, common (HEAD) patterns.
 * Read-only: TAIL content, wildcard patterns, extra text patterns.
 * Does not generate `# HEAD` line — common patterns appear before first timed edition.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { parseEditionFile, HEAD_EDITION_NUMBER, TAIL_EDITION_NUMBER } from '../curation/skylimitEditions'
import type { Edition } from '../curation/skylimitEditions'
import { getAllFollows, getTextSuggestions } from '../curation/skylimitCache'
import type { FollowInfo, SuggestionsMap, TextSuggestions } from '../curation/types'

// --- Editor State Types ---

interface EditorPattern {
  id: string
  handle: string
  textPattern: string
  extraTextPatterns?: string[]  // additional patterns from parsed file, read-only display
  readOnly?: boolean           // true for wildcard patterns
  originalLine?: string        // original text for read-only patterns
}

interface EditorSection {
  id: string
  name: string
  patterns: EditorPattern[]
  collapsed: boolean
}

interface EditorEdition {
  id: string
  type: 'common' | 'timed'
  time: string
  name: string
  sections: EditorSection[]
  collapsed: boolean
}

interface EditorState {
  editions: EditorEdition[]
  warnings: string[]
  preservedTail?: string
}

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
    name: 'Common sections/patterns',
    sections: [{ id: makeId(), name: '', patterns: [], collapsed: false }],
    collapsed: false,
  }
}

/**
 * Extract raw TAIL lines from the original text
 */
function extractTailText(text: string): string | undefined {
  const tailMatch = text.match(/^#\s+TAIL\s*$/im)
  if (!tailMatch || tailMatch.index === undefined) return undefined
  return text.substring(tailMatch.index).trim()
}

/**
 * Convert parsed Edition[] + raw text into EditorState
 */
export function parseLayoutToEditor(text: string): EditorState {
  const warnings: string[] = []
  const editions: EditorEdition[] = []

  if (!text.trim()) {
    return { editions: [makeEmptyCommon()], warnings }
  }

  const parsed = parseEditionFile(text)

  // We ignore parser errors for the visual editor — we convert what we can
  if (parsed.errors.length > 0) {
    warnings.push(...parsed.errors.map(e => `Parse: ${e}`))
  }

  // Process HEAD (editionNumber=0)
  const headEdition = parsed.editions.find(e => e.editionNumber === HEAD_EDITION_NUMBER)
  const common = convertEdition(headEdition, 'common', warnings)
  editions.push(common)

  // Process timed editions
  const timedEditions = parsed.editions
    .filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)
    .sort((a, b) => a.editionNumber - b.editionNumber)

  for (const ed of timedEditions) {
    editions.push(convertEdition(ed, 'timed', warnings))
  }

  // Process TAIL — preserve as raw text
  const preservedTail = extractTailText(text)
  if (preservedTail) {
    warnings.push('TAIL section preserved as read-only')
  }

  return { editions, warnings, preservedTail }
}

function convertEdition(
  parsed: Edition | undefined,
  type: 'common' | 'timed',
  warnings: string[]
): EditorEdition {
  if (!parsed) {
    return type === 'common' ? makeEmptyCommon() : {
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
      const hasWildcard = pat.userPattern.includes('*')
      const extraTexts = pat.textPatterns.length > 1
        ? pat.textPatterns.slice(1).map(tp => tp.pattern)
        : undefined

      if (hasWildcard) {
        warnings.push(`Wildcard pattern "@${pat.userPattern}" shown as read-only`)
      }
      if (extraTexts) {
        warnings.push(`Multiple text patterns for "@${pat.userPattern}" — only first is editable`)
      }

      patterns.push({
        id: makeId(),
        handle: pat.userPattern,
        textPattern: pat.textPatterns.length > 0 ? pat.textPatterns[0].pattern : '',
        extraTextPatterns: extraTexts,
        readOnly: hasWildcard,
        originalLine: hasWildcard
          ? `@${pat.userPattern}${pat.textPatterns.length > 0 ? ': ' + pat.textPatterns.map(tp => tp.pattern).join(', ') : ''}`
          : undefined,
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

  return {
    id: makeId(),
    type,
    time: parsed.time,
    name: type === 'common' ? 'Common sections/patterns' : parsed.name,
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
      // Output common patterns without # HEAD line
      const commonLines = generateEditionPatternLines(edition)
      if (commonLines.length > 0) {
        lines.push(...commonLines)
        lines.push('')
      }
    } else {
      // Timed edition
      const timeName = edition.name
        ? `# ${edition.time} ${edition.name}`
        : `# ${edition.time}`
      lines.push(timeName)
      lines.push(...generateEditionPatternLines(edition))
      lines.push('')
    }
  }

  // Append preserved TAIL
  if (state.preservedTail) {
    lines.push(state.preservedTail)
  }

  return lines.join('\n').trim()
}

function generateEditionPatternLines(edition: EditorEdition): string[] {
  const lines: string[] = []

  for (const section of edition.sections) {
    if (section.name) {
      lines.push(`## ${section.name}`)
    }

    for (const pattern of section.patterns) {
      if (pattern.readOnly && pattern.originalLine) {
        lines.push(pattern.originalLine)
        continue
      }

      const allPatterns = [pattern.textPattern, ...(pattern.extraTextPatterns || [])].filter(Boolean)
      if (allPatterns.length > 0) {
        lines.push(`@${pattern.handle}: ${allPatterns.join(', ')}`)
      } else {
        lines.push(`@${pattern.handle}`)
      }
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
}: {
  value: string
  onChange: (handle: string) => void
  follows: FollowInfo[]
  disabled?: boolean
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
        placeholder="handle.bsky.social"
        className="w-full px-3 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
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
}: {
  value: string
  onChange: (pattern: string) => void
  suggestions: TextSuggestions
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSearch(value)
  }, [value])

  const filtered = useMemo(() => {
    const all = [
      ...suggestions.hashtags.map(h => ({ value: h, type: 'tag' as const })),
      ...suggestions.domains.map(d => ({ value: d, type: 'domain' as const })),
    ]
    if (!search) return all.slice(0, 10)
    const lower = search.toLowerCase()
    return all.filter(item => item.value.toLowerCase().includes(lower)).slice(0, 10)
  }, [suggestions, search])

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
        placeholder="text pattern"
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
              <span className={item.type === 'tag' ? 'text-blue-600 dark:text-blue-400' : ''}>
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

// --- Pattern Row Component ---

function PatternRow({
  pattern,
  follows,
  suggestions,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  pattern: EditorPattern
  follows: FollowInfo[]
  suggestions?: TextSuggestions
  onUpdate: (updated: EditorPattern) => void
  onDelete: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  if (pattern.readOnly) {
    return (
      <div className="flex flex-col gap-1 py-2 px-3 bg-gray-100 dark:bg-gray-800/80 rounded text-sm text-gray-500 dark:text-gray-400 italic">
        <div className="flex items-center gap-2">
          <span className="text-xs">🔒</span>
          <span className="font-mono">{pattern.originalLine || `@${pattern.handle}`}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 py-2">
      {/* Handle + text pattern + delete on one line */}
      <div className="flex items-center gap-2">
        <span className="text-gray-500 dark:text-gray-400 text-sm flex-shrink-0">@</span>
        <div className="flex-[3] min-w-0">
          <HandleAutocomplete
            value={pattern.handle}
            follows={follows}
            onChange={(handle) => onUpdate({ ...pattern, handle })}
          />
        </div>
        <span className="text-gray-400 dark:text-gray-500 text-sm flex-shrink-0">:</span>
        {suggestions ? (
          <div className="flex-[2] min-w-0">
            <TextPatternAutocomplete
              value={pattern.textPattern}
              onChange={(textPattern) => onUpdate({ ...pattern, textPattern })}
              suggestions={suggestions}
            />
          </div>
        ) : (
          <input
            type="text"
            value={pattern.textPattern}
            onChange={(e) => onUpdate({ ...pattern, textPattern: e.target.value })}
            placeholder="text pattern"
            className="flex-[2] min-w-0 px-3 py-1.5 border rounded text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
          />
        )}
        {onMoveUp && (
          <button
            type="button"
            onClick={onMoveUp}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm flex-shrink-0 px-0.5"
            title="Move up"
          >
            ▲
          </button>
        )}
        {onMoveDown && (
          <button
            type="button"
            onClick={onMoveDown}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm flex-shrink-0 px-0.5"
            title="Move down"
          >
            ▼
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 text-sm flex-shrink-0 px-1"
          title="Remove pattern"
        >
          ×
        </button>
      </div>
      {/* Extra patterns (read-only) */}
      {pattern.extraTextPatterns && pattern.extraTextPatterns.length > 0 && (
        <div className="ml-6 text-xs text-gray-400 dark:text-gray-500 italic">
          Also: {pattern.extraTextPatterns.join(', ')}
        </div>
      )}
    </div>
  )
}

// --- Section Component ---

function SectionEditor({
  section,
  isDefault,
  follows,
  suggestionsByHandle,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  section: EditorSection
  isDefault: boolean
  follows: FollowInfo[]
  suggestionsByHandle?: SuggestionsMap
  onUpdate: (updated: EditorSection) => void
  onDelete?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const updatePattern = (idx: number, updated: EditorPattern) => {
    const patterns = [...section.patterns]
    patterns[idx] = updated
    onUpdate({ ...section, patterns })
  }

  const deletePattern = (idx: number) => {
    const patterns = section.patterns.filter((_, i) => i !== idx)
    onUpdate({ ...section, patterns })
  }

  const movePattern = (idx: number, direction: -1 | 1) => {
    const patterns = [...section.patterns]
    const targetIdx = idx + direction
    if (targetIdx < 0 || targetIdx >= patterns.length) return
    ;[patterns[idx], patterns[targetIdx]] = [patterns[targetIdx], patterns[idx]]
    onUpdate({ ...section, patterns })
  }

  const addPattern = () => {
    const patterns = [...section.patterns, {
      id: makeId(),
      handle: '',
      textPattern: '',
    }]
    onUpdate({ ...section, patterns })
  }

  if (isDefault) {
    return (
      <div className="space-y-1">
        {section.patterns.map((pat, idx) => (
          <PatternRow
            key={pat.id}
            pattern={pat}
            follows={follows}
            suggestions={suggestionsByHandle?.get(pat.handle)}
            onUpdate={(updated) => updatePattern(idx, updated)}
            onDelete={() => deletePattern(idx)}
            onMoveUp={idx > 0 ? () => movePattern(idx, -1) : undefined}
            onMoveDown={idx < section.patterns.length - 1 ? () => movePattern(idx, 1) : undefined}
          />
        ))}
        <button
          type="button"
          onClick={addPattern}
          className="text-blue-600 dark:text-blue-400 text-sm hover:underline mt-1"
        >
          + Add Pattern
        </button>
      </div>
    )
  }

  // Named section with collapsible header
  return (
    <div className="border-t border-gray-200 dark:border-gray-700">
      {/* Section header with blue divider lines */}
      <div
        className="flex items-center gap-3 px-4 py-2 bg-gray-50 dark:bg-gray-800/50 cursor-pointer"
        onClick={() => onUpdate({ ...section, collapsed: !section.collapsed })}
      >
        <span className="text-xs text-gray-500">{section.collapsed ? '▶' : '▼'}</span>
        <span className="flex-1 h-px bg-blue-400" />
        <input
          type="text"
          value={section.name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdate({ ...section, name: e.target.value })}
          placeholder="Section Name"
          className="px-2 py-0.5 border rounded text-sm font-semibold uppercase text-blue-600 dark:text-blue-400 bg-transparent dark:border-gray-600 text-center w-40"
        />
        <span className="flex-1 h-px bg-blue-400" />
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {onMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm px-1"
              title="Move section up"
            >
              ▲
            </button>
          )}
          {onMoveDown && (
            <button
              type="button"
              onClick={onMoveDown}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm px-1"
              title="Move section down"
            >
              ▼
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="text-red-500 hover:text-red-700 dark:text-red-400 text-sm flex-shrink-0"
              title="Remove section"
            >
              ×
            </button>
          )}
        </div>
      </div>
      {!section.collapsed && (
        <div className="px-4 py-2 space-y-1">
          {section.patterns.map((pat, idx) => (
            <PatternRow
              key={pat.id}
              pattern={pat}
              follows={follows}
              suggestions={suggestionsByHandle?.get(pat.handle)}
              onUpdate={(updated) => updatePattern(idx, updated)}
              onDelete={() => deletePattern(idx)}
              onMoveUp={idx > 0 ? () => movePattern(idx, -1) : undefined}
              onMoveDown={idx < section.patterns.length - 1 ? () => movePattern(idx, 1) : undefined}
            />
          ))}
          <button
            type="button"
            onClick={addPattern}
            className="text-blue-600 dark:text-blue-400 text-sm hover:underline mt-1"
          >
            + Add Pattern
          </button>
        </div>
      )}
    </div>
  )
}

// --- Edition Card Component ---

function EditionCard({
  edition,
  follows,
  suggestionsByHandle,
  onUpdate,
  onDelete,
}: {
  edition: EditorEdition
  follows: FollowInfo[]
  suggestionsByHandle?: SuggestionsMap
  onUpdate: (updated: EditorEdition) => void
  onDelete?: () => void
}) {
  const isCommon = edition.type === 'common'

  const updateSection = (idx: number, updated: EditorSection) => {
    const sections = [...edition.sections]
    sections[idx] = updated
    onUpdate({ ...edition, sections })
  }

  const deleteSection = (idx: number) => {
    const sections = edition.sections.filter((_, i) => i !== idx)
    onUpdate({ ...edition, sections })
  }

  const moveSection = (idx: number, direction: -1 | 1) => {
    const sections = [...edition.sections]
    const targetIdx = idx + direction
    if (targetIdx < 0 || targetIdx >= sections.length) return
    ;[sections[idx], sections[targetIdx]] = [sections[targetIdx], sections[idx]]
    onUpdate({ ...edition, sections })
  }

  const addSection = () => {
    const sections = [...edition.sections, {
      id: makeId(),
      name: '',
      patterns: [],
      collapsed: false,
    }]
    onUpdate({ ...edition, sections })
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* Edition header */}
      <div
        className="flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 cursor-pointer"
        onClick={() => onUpdate({ ...edition, collapsed: !edition.collapsed })}
      >
        <span className="text-xs text-gray-500">{edition.collapsed ? '▶' : '▼'}</span>

        {isCommon ? (
          <span className="font-semibold text-gray-700 dark:text-gray-300 flex-1">
            Common sections/patterns
          </span>
        ) : (
          <div className="flex items-center gap-2 flex-1" onClick={(e) => e.stopPropagation()}>
            <span className="font-semibold text-gray-700 dark:text-gray-300 flex-shrink-0">
              Edition
            </span>
            <select
              value={edition.time}
              onChange={(e) => onUpdate({ ...edition, time: e.target.value })}
              className="px-2 py-1 border rounded text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
              title="Edition time (24-hour format)"
            >
              <option value="">--:--</option>
              {TIME_OPTIONS.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input
              type="text"
              value={edition.name}
              onChange={(e) => onUpdate({ ...edition, name: e.target.value })}
              placeholder="Edition Name"
              className="flex-1 px-2 py-1 border rounded text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
            />
          </div>
        )}

        {/* Delete button for timed editions */}
        {!isCommon && onDelete && (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={onDelete}
              className="text-red-500 hover:text-red-700 dark:text-red-400 text-sm px-1"
              title="Remove edition"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* Edition body */}
      {!edition.collapsed && (
        <div className="px-4 py-3 space-y-2">
          {edition.sections.map((section, idx) => (
            <SectionEditor
              key={section.id}
              section={section}
              isDefault={section.name === '' && idx === 0}
              follows={follows}
              suggestionsByHandle={suggestionsByHandle}
              onUpdate={(updated) => updateSection(idx, updated)}
              onDelete={idx === 0 && section.name === '' ? undefined : () => deleteSection(idx)}
              onMoveUp={idx > 0 ? () => moveSection(idx, -1) : undefined}
              onMoveDown={idx < edition.sections.length - 1 ? () => moveSection(idx, 1) : undefined}
            />
          ))}
          <button
            type="button"
            onClick={addSection}
            className="text-blue-600 dark:text-blue-400 text-sm hover:underline mt-2"
          >
            + Add Section
          </button>
        </div>
      )}
    </div>
  )
}

// --- Main Component ---

interface EditionLayoutEditorProps {
  layoutText: string
  onSave: (text: string) => Promise<void>
  feedback: { type: 'success' | 'error'; message: string } | null
  headerContent?: React.ReactNode
}

export default function EditionLayoutEditor({ layoutText, onSave, feedback, headerContent }: EditionLayoutEditorProps) {
  const [state, setState] = useState<EditorState>(() => parseLayoutToEditor(layoutText))
  const [follows, setFollows] = useState<FollowInfo[]>([])
  const [suggestTextPatterns, setSuggestTextPatterns] = useState(true)
  const [suggestionsByHandle, setSuggestionsByHandle] = useState<SuggestionsMap>(new Map())
  const [allExpanded, setAllExpanded] = useState(true)
  const initializedRef = useRef(false)

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

  // Re-parse when layoutText changes externally (e.g., switching from text editor)
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      return
    }
    setState(parseLayoutToEditor(layoutText))
  }, [layoutText])

  const updateEdition = (idx: number, updated: EditorEdition) => {
    const editions = [...state.editions]
    editions[idx] = updated
    // Re-sort timed editions by time (ascending), keeping common edition(s) in place
    const common = editions.filter(e => e.type === 'common')
    const timed = editions.filter(e => e.type === 'timed')
    timed.sort((a, b) => a.time.localeCompare(b.time))
    setState({ ...state, editions: [...common, ...timed] })
  }

  const deleteEdition = (idx: number) => {
    const editions = state.editions.filter((_, i) => i !== idx)
    setState({ ...state, editions })
  }

  const addEdition = () => {
    const newEdition: EditorEdition = {
      id: makeId(),
      type: 'timed',
      time: '',
      name: '',
      sections: [{ id: makeId(), name: '', patterns: [], collapsed: false }],
      collapsed: false,
    }
    setState({ ...state, editions: [...state.editions, newEdition] })
  }

  const toggleAllSections = () => {
    const collapse = allExpanded
    const editions = state.editions.map(e => ({
      ...e,
      collapsed: collapse,
      sections: e.sections.map(s => ({ ...s, collapsed: collapse })),
    }))
    setState({ ...state, editions })
    setAllExpanded(!allExpanded)
  }

  const handleSave = async () => {
    const text = generateLayoutText(state)
    await onSave(text)
  }

  // Deduplicate warnings for display
  const uniqueWarnings = [...new Set(state.warnings)]

  // Separate common and timed editions
  const commonEdition = state.editions.find(e => e.type === 'common')
  const timedEditions = state.editions.filter(e => e.type === 'timed')

  const activeSuggestions = suggestTextPatterns ? suggestionsByHandle : undefined

  return (
    <div className="space-y-4">
      {/* Header row: external content + toggle + suggest checkbox */}
      <div className="flex items-center justify-between">
        <div>{headerContent}</div>
        <div className="flex items-center gap-4">
          <button
            onClick={toggleAllSections}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            {allExpanded ? 'Close Sections' : 'Open Sections'}
          </button>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={suggestTextPatterns}
            onChange={(e) => setSuggestTextPatterns(e.target.checked)}
            className="rounded"
          />
          Suggest text patterns
        </label>
        </div>
      </div>

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

      {/* Common patterns card */}
      {commonEdition && (
        <EditionCard
          edition={commonEdition}
          follows={follows}
          suggestionsByHandle={activeSuggestions}
          onUpdate={(updated) => updateEdition(state.editions.indexOf(commonEdition), updated)}
        />
      )}

      {/* Timed edition cards */}
      {timedEditions.map((edition) => {
        const editionIdx = state.editions.indexOf(edition)
        return (
          <EditionCard
            key={edition.id}
            edition={edition}
            follows={follows}
            suggestionsByHandle={activeSuggestions}
            onUpdate={(updated) => updateEdition(editionIdx, updated)}
            onDelete={() => deleteEdition(editionIdx)}
          />
        )
      })}

      {/* Add edition button */}
      <button
        type="button"
        onClick={addEdition}
        className="text-blue-600 dark:text-blue-400 text-sm hover:underline"
      >
        + Add Edition
      </button>

      {/* Read-only TAIL */}
      {state.preservedTail && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <div className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-sm font-medium text-gray-500 dark:text-gray-400">
            TAIL (read-only)
          </div>
          <pre className="px-4 py-3 text-sm font-mono text-gray-500 dark:text-gray-400 whitespace-pre-wrap">
            {state.preservedTail}
          </pre>
        </div>
      )}

      {/* Save button + feedback */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
        >
          Save Edition Layout
        </button>
        {feedback && (
          <span className={`text-sm ${feedback.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  )
}
