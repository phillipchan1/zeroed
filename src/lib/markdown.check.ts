// Standalone integrity check for the chat Markdown parser (no test runner
// installed, same convention as the engine's *.check.ts files).
// Run: node --experimental-strip-types src/lib/markdown.check.ts
//
// What each group exists to stop:
//
//   · the old renderer flattened everything it didn't know — a table became a
//     paragraph of pipes, a fence became a paragraph, a nested bullet became a
//     top-level one. Each block type is pinned here.
//   · chat line breaks: "a\nb" must stay two lines when `breaks` is on (a model
//     and a thumb-typed message both mean it) and join when it is off (documents).
//   · links are the only inline that can carry an attacker-chosen string. Only
//     http(s) and mailto survive; javascript: / data: stay inert text.
//   · half-written / ragged input must degrade to something readable, never throw
//     and never drop content.

import { parseMarkdown, parseInline, safeHref } from './markdown.ts'
import type { Block, Inline } from './markdown.ts'

const fails: string[] = []
let checks = 0

function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) fails.push(msg)
}
function eq<T>(actual: T, expected: T, msg: string) {
  checks++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fails.push(`${msg}\n    expected ${e}\n    got      ${a}`)
}

const types = (bs: Block[]) => bs.map((b) => b.t)
const plain = (c: Inline[]) => c.map((i) => (i.t === 'br' ? '\n' : i.v)).join('')

// ---- inline ------------------------------------------------------------------

eq(parseInline('a **b** c'), [{ t: 'text', v: 'a ' }, { t: 'strong', v: 'b' }, { t: 'text', v: ' c' }], 'bold')
eq(parseInline('a *b* c').map((i) => i.t), ['text', 'em', 'text'], 'italic')
eq(parseInline('run `225 lbs` now').map((i) => i.t), ['text', 'code', 'text'], 'inline code')
eq(parseInline('2 * 3 * 4'), [{ t: 'text', v: '2 * 3 * 4' }], 'spaced asterisks are arithmetic, not emphasis')
eq(parseInline('snake_case_name'), [{ t: 'text', v: 'snake_case_name' }], 'intraword underscores are not emphasis')
eq(parseInline('see [the plan](https://x.test/p) ok'), [
  { t: 'text', v: 'see ' }, { t: 'link', href: 'https://x.test/p', v: 'the plan' }, { t: 'text', v: ' ok' },
], 'markdown link')
eq(parseInline('go to https://x.test/a/b, then stop.'), [
  { t: 'text', v: 'go to ' }, { t: 'link', href: 'https://x.test/a/b', v: 'https://x.test/a/b' }, { t: 'text', v: ', then stop.' },
], 'bare url drops trailing sentence punctuation')
eq((parseInline('(see https://en.wikipedia.org/wiki/Squat_(exercise))')[1] as { href: string }).href,
  'https://en.wikipedia.org/wiki/Squat_(exercise)', 'balanced closing paren stays in the url')

// ---- link safety --------------------------------------------------------------

eq(safeHref('javascript:alert(1)'), null, 'javascript: refused')
eq(safeHref('  JAVASCRIPT:alert(1)'), null, 'javascript: refused with padding/case')
eq(safeHref('data:text/html;base64,AAAA'), null, 'data: refused')
eq(safeHref('https://ok.test'), 'https://ok.test', 'https allowed')
eq(safeHref('mailto:a@b.test'), 'mailto:a@b.test', 'mailto allowed')
eq(parseInline('[click](javascript:alert(1))').some((i) => i.t === 'link'), false, 'unsafe markdown link is not a link')
eq(plain(parseInline('[click](javascript:alert(1))')), '[click](javascript:alert(1))', 'unsafe link text is kept, inert')

// ---- paragraphs and breaks ------------------------------------------------------

eq(types(parseMarkdown('one\n\ntwo')), ['p', 'p'], 'blank line splits paragraphs')
eq(plain((parseMarkdown('Lower A\nUpper A')[0] as { c: Inline[] }).c), 'Lower A Upper A', 'documents join soft breaks with a space')
eq(plain((parseMarkdown('Lower A\nUpper A', { breaks: true })[0] as { c: Inline[] }).c), 'Lower A\nUpper A', 'chat keeps single newlines as line breaks')
eq(parseMarkdown('a\r\nb', { breaks: true }).length, 1, 'CRLF is normalised')
eq(parseMarkdown('   \n \n'), [], 'whitespace only parses to nothing')
eq(parseMarkdown(''), [], 'empty parses to nothing')

// ---- headings / rules -------------------------------------------------------------

eq(types(parseMarkdown('# A\n## B\n### C\n#### D')), ['h', 'h', 'h', 'h'], 'headings')
eq((parseMarkdown('#### D')[0] as { level: number }).level, 3, 'h4+ clamp to the smallest heading')
eq(plain((parseMarkdown('## Learning C#')[0] as { c: Inline[] }).c), 'Learning C#', 'a trailing # that is part of the word survives')
eq(types(parseMarkdown('a\n\n---\n\nb')), ['p', 'hr', 'p'], 'horizontal rule')
eq(types(parseMarkdown('***')), ['hr'], 'asterisk rule is a rule, not a list')

// ---- lists -------------------------------------------------------------------------

{
  const [l] = parseMarkdown('- a\n- b\n* c\n+ d') as Extract<Block, { t: 'list' }>[]
  eq([l.t, l.ordered, l.items.length], ['list', false, 4], 'bullets of every marker form one list')
}
{
  const [l] = parseMarkdown('3. a\n4. b') as Extract<Block, { t: 'list' }>[]
  eq([l.ordered, l.start, l.items.length], [true, 3, 2], 'numbered list keeps its start')
}
{
  const [l] = parseMarkdown('- a\n  - a1\n  - a2\n- b') as Extract<Block, { t: 'list' }>[]
  eq(l.items.length, 2, 'nested bullets do not become top-level items')
  const sub = l.items[0].sub?.[0] as Extract<Block, { t: 'list' }> | undefined
  eq(sub?.items.map((i) => plain(i.c)), ['a1', 'a2'], 'nested items sit under their parent')
  ok(l.items[1].sub === undefined, 'a sibling after a nested list has no children')
}
{
  const bs = parseMarkdown('- a\n1. b')
  eq(types(bs), ['list', 'list'], 'switching list kind starts a new list')
}
{
  const [l] = parseMarkdown('- squat\n  with a long wrapped line\n- next') as Extract<Block, { t: 'list' }>[]
  eq(plain(l.items[0].c), 'squat with a long wrapped line', 'an indented continuation joins its item')
}
eq(types(parseMarkdown('Do this:\n- a\n- b')), ['p', 'list'], 'a list directly under a sentence still parses as a list')

// ---- quotes ---------------------------------------------------------------------------

{
  const [q] = parseMarkdown('> note\n> - a\n> - b') as Extract<Block, { t: 'quote' }>[]
  eq(q.t, 'quote', 'blockquote')
  eq(types(q.c), ['p', 'list'], 'a quote parses its own blocks')
}

// ---- code ----------------------------------------------------------------------------------

{
  const [c] = parseMarkdown('```ts\nconst a = 1\n  indented\n```') as Extract<Block, { t: 'code' }>[]
  eq([c.t, c.lang, c.v], ['code', 'ts', 'const a = 1\n  indented'], 'fence keeps content and indentation verbatim')
}
eq((parseMarkdown('```\n**not bold** | not | a table\n```')[0] as { v: string }).v, '**not bold** | not | a table', 'nothing inside a fence is interpreted')
{
  const bs = parseMarkdown('```\nhalf written\nstill code')
  eq(types(bs), ['code'], 'an unclosed fence runs to the end instead of leaking out')
  eq((bs[0] as { v: string }).v, 'half written\nstill code', 'and keeps its content')
}

// ---- tables -----------------------------------------------------------------------------------

{
  const [t] = parseMarkdown('| Lift | Left | Right |\n|:--|--:|:-:|\n| Split squat | 6 | 8 |\n| Copenhagen | 22s | 31s |') as Extract<Block, { t: 'table' }>[]
  eq(t.t, 'table', 'table')
  eq(t.head.map(plain), ['Lift', 'Left', 'Right'], 'table head')
  eq(t.align, ['left', 'right', 'center'], 'table alignment')
  eq(t.rows.map((r) => r.map(plain)), [['Split squat', '6', '8'], ['Copenhagen', '22s', '31s']], 'table rows')
}
{
  const [t] = parseMarkdown('a | b | c\n--|--|--\n1 | 2\n1 | 2 | 3 | 4') as Extract<Block, { t: 'table' }>[]
  eq(t.t, 'table', 'a table without outer pipes')
  eq(t.rows.map((r) => r.length), [3, 3], 'ragged rows are normalised to the header width')
}
eq(types(parseMarkdown('a | b\nnot a separator')), ['p'], 'pipes without a separator row are just text')
eq(types(parseMarkdown('| a |\n|---|\n| 1 |\n\nafter')), ['table', 'p'], 'a blank line ends the table')

// ---- mixed: a realistic reply ---------------------------------------------------------------------

{
  const reply = [
    '## Why the left hip', '',
    'Your **left hip** gives out first.', '',
    '- Split squat: left stalls **2 reps earlier**',
    '- Depth drops past `225 lbs`', '',
    '1. Within 10% for two weeks',
    '2. A clean `275×5`', '',
    '> Log it next session.', '',
    '| Lift | L | R |', '|---|---|---|', '| Split | 6 | 8 |', '',
    '```', 'swap_to_single_leg()', '```', '',
    'Read more at https://example.test/protocol.',
  ].join('\n')
  eq(types(parseMarkdown(reply, { breaks: true })), ['h', 'p', 'list', 'list', 'quote', 'table', 'code', 'p'], 'a full reply parses block-for-block')
}

// ---- never throws, never loses text ------------------------------------------------------------------

for (const hostile of ['|', '| |\n|-|', '```', '> ', '- ', '1.', '**', '[', '[](', '`', '#', '\\', '|--|--|', '> > > a', '-\t-\t-']) {
  let threw = false
  try { parseMarkdown(hostile, { breaks: true }); parseMarkdown(hostile) } catch { threw = true }
  ok(!threw, `does not throw on ${JSON.stringify(hostile)}`)
}

if (fails.length) {
  console.error(`markdown.check: ${fails.length} of ${checks} checks FAILED`)
  for (const f of fails) console.error(` ✗ ${f}`)
  process.exit(1)
}
console.log(`markdown.check: ${checks} checks passed`)
