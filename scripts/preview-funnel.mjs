/* Dev-only visual harness for the signed-out onboarding funnel. Not shipped. */
import { chromium } from 'playwright'

const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:5199'
const OUT = process.env.PREVIEW_OUT || '.'

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
await ctx.route('**/fonts.googleapis.com/**', (r) => r.abort())
await ctx.route('**/fonts.gstatic.com/**', (r) => r.abort())
const page = await ctx.newPage()

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/f1-splash.png` })

await page.click('body')
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/f2-arena.png`, fullPage: true })

// Pick "A number", continue.
await page.getByText('A number', { exact: true }).click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: /Continue/ }).click()
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/f3-limiter.png`, fullPage: true })

console.log('funnel shots done')
await browser.close()
