// A small, safe Markdown parser for chat copy. Pure: text in, a plain-data tree
// out, so it can be checked with node and rendered by any UI. The renderer
// (components/ui Markdown) builds React nodes from this tree — nothing here ever
// produces HTML, so there is no injection surface.
//
// The subset is what a coaching model actually writes, plus what it will write
// the moment it feels like a table:
//   blocks  — paragraphs, # headings, bullet / numbered lists (nested by indent),
//             > quotes, ``` fences, --- rules, | tables |
//   inline  — **bold**, *italic*, `code`, [text](url), bare https:// links
// Inline is deliberately flat (no emphasis inside emphasis): coach copy never
// nests it, and flat keeps the parser honest.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; v: string }
  | { t: 'br' }

export interface ListItem {
  c: Inline[]
  /** Lists nested under this item. */
  sub?: Block[]
}

export type Align = 'left' | 'right' | 'center' | null

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }

export interface ParseOptions {
  /**
   * Treat a single newline inside a paragraph as a line break. Chat wants this:
   * a model (and a person typing on a phone) breaks lines to mean it, and
   * joining them with a space turns "Lower A\nUpper A" into one run-on line.
   * Documents (reviews, notes) keep standard Markdown and join with a space.
   */
  breaks?: boolean
}

// ---- inline -----------------------------------------------------------------

const INLINE_RE = new RegExp(
  [
    '`([^`\\n]+)`',                                        // 1  code
    '\\*\\*(?![\\s*])([^*\\n]*[^*\\s])\\*\\*',              // 2  **bold**
    '__(?![\\s_])([^_\\n]*[^_\\s])__',                      // 3  __bold__
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)',                  // 4,5 [text](url)
    '(https?:\\/\\/[^\\s<>]+)',                            // 6  bare url
    '\\*(?![\\s*])([^*\\n]*[^*\\s])\\*',                    // 7  *italic*
    '(?<![A-Za-z0-9])_([^_\\n]+)_(?![A-Za-z0-9])',         // 8  _italic_
  ].join('|'),
  'g',
)

/** http(s) and mailto only — anything else (javascript:, data:) stays text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim()
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null
}

// Trailing punctuation belongs to the sentence, not the link.
function splitUrlTail(url: string): [string, string] {
  let end = url.length
  while (end > 0 && /[.,;:!?'")\]]/.test(url[end - 1])) {
    // keep a closing paren that balances one inside the url (wikipedia-style)
    if (url[end - 1] === ')' && (url.slice(0, end).match(/\(/g)?.length ?? 0) >= (url.slice(0, end).match(/\)/g)?.length ?? 0)) break
    end--
  }
  return [url.slice(0, end), url.slice(end)]
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  const push = (v: string) => {
    if (!v) return
    const prev = out[out.length - 1]
    if (prev && prev.t === 'text') prev.v += v   // adjacent text is one node
    else out.push({ t: 'text', v })
  }
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index))
    last = INLINE_RE.lastIndex
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] })
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: 'strong', v: (m[2] ?? m[3]) as string })
    else if (m[4] !== undefined) {
      const href = safeHref(m[5])
      if (href) out.push({ t: 'link', href, v: m[4] })
      else push(m[0])
    } else if (m[6] !== undefined) {
      const [url, tail] = splitUrlTail(m[6])
      out.push({ t: 'link', href: url, v: url })
      push(tail)
    } else if (m[7] !== undefined || m[8] !== undefined) out.push({ t: 'em', v: (m[7] ?? m[8]) as string })
  }
  if (last < text.length) push(text.slice(last))
  return out
}

function inlineLines(lines: string[], breaks: boolean): Inline[] {
  if (!breaks) return parseInline(lines.join(' '))
  const out: Inline[] = []
  lines.forEach((l, i) => {
    if (i > 0) out.push({ t: 'br' })
    out.push(...parseInline(l))
  })
  return out
}

// ---- blocks -----------------------------------------------------------------

const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/
const NUMBER_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const indentOf = (line: string): number => {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

function alignOf(cell: string): Align {
  const c = cell.trim()
  const l = c.startsWith(':')
  const r = c.endsWith(':')
  return l && r ? 'center' : r ? 'right' : l ? 'left' : null
}

const isListLine = (l: string) => BULLET_RE.test(l) || NUMBER_RE.test(l)

/**
 * A table starts where a pipe row is immediately followed by a --- separator
 * with the same number of cells (GFM's rule — and what keeps "a | b" above a
 * stray "---" from being mistaken for one).
 */
const startsTable = (lines: string[], i: number) =>
  i + 1 < lines.length
  && lines[i].includes('|') && lines[i + 1].includes('|')
  && TABLE_SEP_RE.test(lines[i + 1])
  && splitRow(lines[i]).length === splitRow(lines[i + 1]).length

function parseList(lines: string[], start: number, opts: ParseOptions): [Block, number] {
  const first = lines[start]
  const bullet = BULLET_RE.exec(first)
  const num = bullet ? null : NUMBER_RE.exec(first)
  const baseIndent = indentOf(first)
  const ordered = !bullet
  const items: ListItem[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) break
    const ind = indentOf(line)
    const b = BULLET_RE.exec(line)
    const n = NUMBER_RE.exec(line)
    if ((b || n) && ind >= baseIndent + 2) {
      // Deeper: nests under the previous item.
      const [sub, next] = parseList(lines, i, opts)
      if (items.length) (items[items.length - 1].sub ??= []).push(sub)
      i = next
      continue
    }
    if ((b || n) && ind <= baseIndent + 1) {
      if (ind < baseIndent) break                  // belongs to a shallower list
      if (!!b === ordered) break                   // switched list kind → a new list
      items.push({ c: parseInline((b ? b[2] : (n as RegExpExecArray)[3]).trim()) })
      i++
      continue
    }
    // Not a list line: an indented continuation of the current item, else stop.
    if (ind > baseIndent && items.length && !startsFence(line) && !HEADING_RE.test(line)) {
      items[items.length - 1].c.push({ t: 'text', v: ' ' }, ...parseInline(line.trim()))
      i++
      continue
    }
    break
  }
  return [{ t: 'list', ordered, start: ordered && num ? Math.max(0, parseInt(num[2], 10)) : 1, items }, i]
}

const startsFence = (l: string) => FENCE_RE.test(l)

export function parseMarkdown(text: string, opts: ParseOptions = {}): Block[] {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines, opts)
}

function parseBlocks(lines: string[], opts: ParseOptions): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) {
      blocks.push({ t: 'p', c: inlineLines(para, !!opts.breaks) })
      para = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { flush(); i++; continue }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      // An unclosed fence runs to the end — a half-written block is still code.
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) { body.push(lines[i]); i++ }
      i++
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }

    const h = HEADING_RE.exec(line)
    if (h) {
      flush()
      blocks.push({ t: 'h', level: Math.min(3, h[1].length) as 1 | 2 | 3, c: parseInline(h[2]) })
      i++
      continue
    }

    if (HR_RE.test(line)) { flush(); blocks.push({ t: 'hr' }); i++; continue }

    if (QUOTE_RE.test(line)) {
      flush()
      const inner: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) { inner.push((QUOTE_RE.exec(lines[i]) as RegExpExecArray)[1]); i++ }
      blocks.push({ t: 'quote', c: parseBlocks(inner, opts) })
      continue
    }

    if (startsTable(lines, i)) {
      flush()
      const head = splitRow(lines[i])
      const align = splitRow(lines[i + 1]).map(alignOf)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i])
        // Ragged rows are normalised to the header's width.
        rows.push(head.map((_, c) => parseInline(cells[c] ?? '')))
        i++
      }
      blocks.push({ t: 'table', align: head.map((_, c) => align[c] ?? null), head: head.map(parseInline), rows })
      continue
    }

    if (isListLine(line)) {
      flush()
      const [list, next] = parseList(lines, i, opts)
      blocks.push(list)
      i = next
      continue
    }

    para.push(line.trim())
    i++
  }
  flush()
  return blocks
}
