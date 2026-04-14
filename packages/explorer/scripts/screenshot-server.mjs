#!/usr/bin/env node
// Headless screenshot server for the Arkeon explorer graph.
// Returns PNGs of the rendered graph via HTTP. Listens on 127.0.0.1 only.
//
// Start:  node scripts/screenshot-server.mjs
// Usage:  curl http://localhost:3200/screenshot > graph.png
//         curl "http://localhost:3200/screenshot?select=<entity-id>" > selected.png
//         curl "http://localhost:3200/screenshot?mock" > mock.png
//
// Query params (all optional):
//   select  — entity ID to select and zoom to
//   width   — viewport width (default 1400, max 3840)
//   height  — viewport height (default 900, max 2160)
//   wait    — ms to wait after load for layout to settle (default 3000, max 10000)
//   mock    — use mock data instead of real API (for dev without a running instance)
//
// Env vars:
//   EXPLORER_URL     — explorer base URL (default: http://localhost:8000/explore/)
//   SCREENSHOT_PORT  — port to listen on (default: 3200)

import { createServer } from 'node:http'
import { chromium } from 'playwright'

const PORT = parseInt(process.env.SCREENSHOT_PORT || '3200', 10)
const BASE_URL = process.env.EXPLORER_URL || 'http://localhost:8000/explore/'
const MAX_CONCURRENT = 3
const MAX_WAIT = 10_000

let browser = null
let activePagesCount = 0

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
    })
  }
  return browser
}

async function takeScreenshot(params) {
  const width = Math.min(parseInt(params.get('width') || '1400', 10) || 1400, 3840)
  const height = Math.min(parseInt(params.get('height') || '900', 10) || 900, 2160)
  const wait = Math.min(parseInt(params.get('wait') || '3000', 10) || 3000, MAX_WAIT)
  const select = params.get('select')
  const mock = params.has('mock')

  const url = new URL(BASE_URL)
  if (mock) url.searchParams.set('mock', '')
  if (select) url.searchParams.set('select', select)

  const b = await getBrowser()
  const page = await b.newPage({ viewport: { width, height } })

  try {
    await page.goto(url.toString(), { waitUntil: 'networkidle' })
    await page.waitForTimeout(wait)
    return await page.screenshot({ type: 'png' })
  } finally {
    await page.close()
    activePagesCount--
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname !== '/screenshot') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end([
      'GET /screenshot — capture the explorer graph as PNG',
      '',
      'Query params:',
      '  select=<id>   select and zoom to an entity',
      '  mock          use mock data (no running instance needed)',
      '  width=N       viewport width (default 1400, max 3840)',
      '  height=N      viewport height (default 900, max 2160)',
      '  wait=N        ms to wait for layout (default 3000, max 10000)',
      '',
      `Target: ${BASE_URL}`,
      '',
    ].join('\n'))
    return
  }

  if (activePagesCount >= MAX_CONCURRENT) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '5' })
    res.end('Too many concurrent screenshots. Try again shortly.\n')
    return
  }
  activePagesCount++

  const start = Date.now()
  try {
    const png = await takeScreenshot(url.searchParams)
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'no-store',
    })
    res.end(png)
    console.log(`screenshot ${url.search || '(default)'} — ${Date.now() - start}ms`)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end(`Screenshot failed: ${err.message}\n`)
    console.error(`screenshot error: ${err.message}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Screenshot server: http://127.0.0.1:${PORT}/screenshot`)
  console.log(`Target explorer:   ${BASE_URL}`)
  console.log(`Max concurrent:    ${MAX_CONCURRENT}`)
  console.log(`\nExamples:`)
  console.log(`  curl http://localhost:${PORT}/screenshot > /tmp/graph.png`)
  console.log(`  curl "http://localhost:${PORT}/screenshot?select=<entity-id>" > /tmp/selected.png`)
  console.log(`  curl "http://localhost:${PORT}/screenshot?mock" > /tmp/mock.png`)
})

process.on('SIGINT', async () => {
  if (browser) await browser.close()
  process.exit(0)
})
