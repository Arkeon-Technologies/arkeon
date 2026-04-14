#!/usr/bin/env node
// Headless screenshot server for the Arkeon explorer graph.
// Returns PNGs of the rendered graph via HTTP.
//
// Start:  node scripts/screenshot-server.mjs
// Usage:  curl http://localhost:3200/screenshot > graph.png
//         curl "http://localhost:3200/screenshot?select=<entity-id>" > selected.png
//         curl "http://localhost:3200/screenshot?mock" > mock.png
//
// Query params (all optional):
//   select  — entity ID to select and zoom to
//   width   — viewport width (default 1400)
//   height  — viewport height (default 900)
//   wait    — ms to wait after load for layout to settle (default 3000)
//   mock    — use mock data instead of real API (for dev without a running instance)
//   base    — override explorer base URL
//
// Env vars:
//   EXPLORER_URL     — default base URL (default: http://localhost:8000/explore/)
//   SCREENSHOT_PORT  — port to listen on (default: 3200)

import { createServer } from 'node:http'
import { chromium } from 'playwright'

const PORT = parseInt(process.env.SCREENSHOT_PORT || '3200', 10)
const DEFAULT_BASE = process.env.EXPLORER_URL || 'http://localhost:8000/explore/'

let browser = null

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
    })
  }
  return browser
}

async function takeScreenshot(params) {
  const base = params.get('base') || DEFAULT_BASE
  const width = parseInt(params.get('width') || '1400', 10)
  const height = parseInt(params.get('height') || '900', 10)
  const wait = parseInt(params.get('wait') || '3000', 10)
  const select = params.get('select')
  const mock = params.has('mock')

  const url = new URL(base)
  if (mock) url.searchParams.set('mock', '')
  if (select) url.searchParams.set('select', select)

  const b = await getBrowser()
  const page = await b.newPage({ viewport: { width, height } })

  try {
    await page.goto(url.toString(), { waitUntil: 'networkidle' })
    await page.waitForTimeout(wait)
    const buffer = await page.screenshot({ type: 'png' })
    return buffer
  } finally {
    await page.close()
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
      '  width=N       viewport width (default 1400)',
      '  height=N      viewport height (default 900)',
      '  wait=N        ms to wait for layout (default 3000)',
      '',
      `Target: ${DEFAULT_BASE}`,
      '',
    ].join('\n'))
    return
  }

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

server.listen(PORT, () => {
  console.log(`Screenshot server: http://localhost:${PORT}/screenshot`)
  console.log(`Target explorer:   ${DEFAULT_BASE}`)
  console.log(`\nExamples:`)
  console.log(`  curl http://localhost:${PORT}/screenshot > /tmp/graph.png`)
  console.log(`  curl "http://localhost:${PORT}/screenshot?select=<entity-id>" > /tmp/selected.png`)
  console.log(`  curl "http://localhost:${PORT}/screenshot?mock" > /tmp/mock.png`)
})

process.on('SIGINT', async () => {
  if (browser) await browser.close()
  process.exit(0)
})
