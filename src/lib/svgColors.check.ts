// Standalone check: no CSS variable inside an SVG colour attribute.
// Run: node --experimental-strip-types src/lib/svgColors.check.ts
//
// The bug this stops: lucide's `color` prop, and a bare `stroke=` / `fill=` on
// an SVG element, become presentation ATTRIBUTES — `stroke="var(--text-dim)"`.
// Chrome resolves var() there; WebKit (iOS Safari and the iOS app's WKWebView)
// can't be relied on to, and where it doesn't the stroke draws as nothing: the
// tab bar's icons went missing on a phone while looking perfect in a desktop
// browser. The set check and the Convergence reticle used the same pattern.
// A colour that is a token goes through CSS instead: `style={{ color: … }}`
// (lucide strokes currentColor) or `style={{ stroke: … }}` on a raw element.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const files: string[] = []
;(function walk(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.tsx')) files.push(p)
  }
})(root)

// ` color="var(…"`, ` stroke={x ? 'var(…' : …}` and so on — an attribute, not
// a `style` object key (those are `color:`, which this never matches).
const BAD = /\s(color|stroke|fill)=(?:"[^"]*var\(|\{[^}\n]*var\()/g

let failed = 0
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(BAD)) {
      failed++
      console.error(`FAIL ${relative(root, file)}:${i + 1} — ${m[1]}= with var(); use style={{ ${m[1] === 'color' ? 'color' : m[1]}: … }}`)
    }
  })
}

// The pattern itself, so a refactor of BAD can't quietly match nothing.
const probe = (s: string) => [...s.matchAll(BAD)].length
if (probe(` <X color="var(--a)" />`) !== 1) { failed++; console.error('FAIL probe: literal attribute') }
if (probe(` <X color={on ? 'var(--a)' : 'var(--b)'} />`) !== 1) { failed++; console.error('FAIL probe: expression attribute') }
if (probe(` <X style={{ color: 'var(--a)' }} />`) !== 0) { failed++; console.error('FAIL probe: style object') }

if (failed) { console.error(`${failed} failed`); process.exit(1) }
console.log(`svgColors.check: ok (${files.length} files)`)
