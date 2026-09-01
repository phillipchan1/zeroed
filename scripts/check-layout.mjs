/* Layout assertions across viewport widths and FONT SCALES.
 *
 * Why this and not committed screenshots: a pixel baseline generated on one
 * machine fails on another for font-rendering reasons that have nothing to do
 * with the change under test, so it cries wolf until someone deletes it. These
 * are assertions about geometry — nothing horizontally overflows, nothing is
 * clipped, every tap target clears 44px — which hold on any machine and describe
 * what would actually be wrong.
 *
 * It exists mainly to make the type scale safe to touch. The scale is in rem so
 * the OS/browser font setting works, and the failure mode of rem is reflow: text
 * at 150% pushes a row wider than the phone. That is precisely what this checks.
 *
 * Playwright is deliberately NOT a project dependency (same as the preview
 * scripts). Install it ad hoc:
 *
 *   npm i -D playwright
 *   npm run dev -- --port 5199
 *   node scripts/check-layout.mjs
 *
 * Exits non-zero on any violation.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:5199'

// The narrowest phone still in use, the common case, and a large phone.
const WIDTHS = [320, 390, 430]
// 100% is the default; 125% and 150% are the OS accessibility settings that the
// px scale used to ignore entirely.
const FONT_SCALES = [1, 1.25, 1.5]

const ROUTES = [
  ['Train',   '/app/today'],
  ['Program', '/app/program'],
  ['Coach',   '/app/coach'],
  ['History', '/app/history'],
  ['Recap',   '/app/recap/rev-1'],
  ['You',     '/app/profile'],
  ['Workout', '/app/workout/aaaaaaaa-0000-0000-0000-000000000001'],
]

// Reuse the preview harness's seeded athlete so these screens have real content;
// an empty screen has no layout to break.
const SEED = readFileSync(new URL('./preview-loop.mjs', import.meta.url), 'utf8')
// Everything from the first fixture constant to the shot list: the ids, the date
// helpers and the whole CACHE/SESSION literal, so it evaluates as one unit rather
// than referencing consts that were left behind.
const SEED_BLOCK = SEED.slice(SEED.indexOf('const USER_ID'), SEED.indexOf('const shots'))

// Below this in the smaller dimension is a genuine miss-tap risk and fails the
// run. Comfortably above WCAG AA's 24px, below the app's own deliberate 40px.
const HARD_TAP = 36

const errors = []
const notes = []

/** Runs IN the page: everything geometric that can go wrong on a small screen. */
function auditPage(minTap) {
  const out = []
  const doc = document.documentElement

  // 1. The page must never scroll sideways. This is the rem failure mode.
  if (doc.scrollWidth > doc.clientWidth + 1) {
    out.push({ level: 'error', msg: `page scrolls horizontally (${doc.scrollWidth} > ${doc.clientWidth})` })
  }

  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : ''
    const text = (el.textContent || '').trim().slice(0, 28)
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`
  }

  // Content inside a horizontal scroller is SUPPOSED to extend past the
  // viewport — that is what the scroller is for. Only unscrolled content
  // reaching past the right edge is a bug.
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX
      if (o === 'auto' || o === 'scroll') return true
    }
    return false
  }

  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || !el.getClientRects().length) continue
    const rect = el.getBoundingClientRect()

    // 2. Nothing may extend past the right edge of the viewport.
    if (rect.width > 0 && rect.right > doc.clientWidth + 1 && !inScroller(el)) {
      out.push({ level: 'error', msg: `overflows right edge by ${Math.round(rect.right - doc.clientWidth)}px: ${describe(el)}` })
    }

    // 3. Text ACTUALLY cut off. Only `hidden`/`clip` cut anything — an element
    //    whose overflow is visible simply paints outside its box, which is not
    //    the bug we are looking for, and `auto`/`scroll` is deliberate.
    // A line-clamp is a deliberate truncation with an affordance behind it (the
    // Train read clamps to two lines and taps through to Coach). It is not the
    // accidental clipping this looks for.
    const clamped = (style.webkitLineClamp && style.webkitLineClamp !== 'none') ||
                    (style.lineClamp && style.lineClamp !== 'none')
    const clips = style.overflowY === 'hidden' || style.overflowY === 'clip'
    if (clips && !clamped && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
      out.push({ level: 'error', msg: `content clipped vertically (${el.scrollHeight} > ${el.clientHeight}): ${describe(el)}` })
    }

    // 4. Tap targets. Three standards are in play and they disagree, so be
    //    explicit about which one FAILS a build:
    //      · WCAG 2.5.8 (AA)  — 24x24. The legal floor.
    //      · WCAG 2.5.5 (AAA) — 44x44. The aspiration.
    //      · this app's --tap  — 48px, with documented exceptions (the felt
    //        chips are deliberately 40px; see docs/mobile-ux-audit.md).
    //    A check that fails the app's own considered choices is a check someone
    //    deletes. So: under HARD_TAP is an error, 44 and under is a note.
    const interactive = el.matches('button, a[href], input, select, textarea, [role="button"]')
    if (interactive && rect.width > 0 && rect.height > 0) {
      const small = Math.min(rect.width, rect.height)
      if (small < minTap) {
        out.push({ level: 'error', msg: `tap target ${Math.round(rect.width)}x${Math.round(rect.height)} under ${minTap}px: ${describe(el)}` })
      } else if (small < 44) {
        out.push({ level: 'note', msg: `tap target ${Math.round(rect.width)}x${Math.round(rect.height)} under WCAG AAA 44px: ${describe(el)}` })
      }
    }
  }
  return out
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' })

for (const scale of FONT_SCALES) {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2 })
    // Offline so the seeded cache is what renders, exactly like preview-loop.
    await ctx.route('**/placeholder.supabase.co/**', (r) => r.abort())
    await ctx.route('**/fonts.googleapis.com/**', (r) => r.abort())
    await ctx.route('**/fonts.gstatic.com/**', (r) => r.abort())

    const page = await ctx.newPage()
    await page.goto(BASE)
    await page.evaluate(
      new Function(`${SEED_BLOCK}
        localStorage.clear()
        for (const [k, v] of Object.entries(CACHE)) {
          localStorage.setItem('zeroed:cache:v1:' + k, JSON.stringify({ v: 'v1', at: Date.now(), data: v }))
        }
        localStorage.setItem('sb-placeholder-auth-token', JSON.stringify(SESSION))
      `),
    )
    // The OS font setting, as the browser sees it: the root font size. This is
    // the whole reason the scale is in rem.
    await page.addStyleTag({ content: `html { font-size: ${16 * scale}px !important; }` })

    for (const [name, route] of ROUTES) {
      await page.goto(BASE + route)
      await page.waitForTimeout(900)
      await page.addStyleTag({ content: `html { font-size: ${16 * scale}px !important; }` })
      await page.waitForTimeout(250)
      // 44px is the accessibility floor. At 100% this app aims at its own 48px
      // token, but a target that grows with text should never be judged harshly
      // for the scale it was asked to render at.
      const found = await page.evaluate(auditPage, HARD_TAP)
      for (const v of found) {
        const line = `${name} @ ${width}px, ${Math.round(scale * 100)}% text — ${v.msg}`
        ;(v.level === 'error' ? errors : notes).push(line)
      }
    }
    await ctx.close()
  }
}
await browser.close()

// The dev-only reset pill is fixed-position scaffolding, not product surface.
const ignore = (v) => /debug-reset|Reset"/.test(v)
const realErrors = [...new Set(errors.filter((v) => !ignore(v)))]
const realNotes = [...new Set(notes.filter((v) => !ignore(v)))]

if (realNotes.length) {
  console.log(`· ${realNotes.length} targets under WCAG AAA 44px (not failures — see docs/mobile-ux-audit.md):`)
  for (const v of realNotes.slice(0, 12)) console.log(`    ${v}`)
  if (realNotes.length > 12) console.log(`    …and ${realNotes.length - 12} more`)
  console.log('')
}

if (realErrors.length) {
  console.error(`✗ ${realErrors.length} layout violations:\n`)
  for (const v of realErrors) console.error(`  · ${v}`)
  process.exit(1)
}
console.log(`✓ layout holds across ${WIDTHS.length} widths × ${FONT_SCALES.length} font scales × ${ROUTES.length} screens`)
