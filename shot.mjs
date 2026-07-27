import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
await p.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)
await p.screenshot({ path: '01-splash.png' })
await p.click('body')
await p.waitForTimeout(800)
await p.screenshot({ path: '02-arena.png', fullPage: true })
// pick first arena, continue
const cards = await p.$$('button')
await p.waitForTimeout(200)
await b.close()
