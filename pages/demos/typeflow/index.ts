// Typeflow — Kinetic Typography Demo
//
// Uses Pretext's prepare() + layoutWithLines() to compute per-line geometry
// without any DOM measurement in the layout hot path.
//
// Features:
//  • Full-screen canvas constellation background
//  • Per-line width-fill bars visualising how full each line is
//  • Stagger-animated line cascade when quotes change or font resizes
//  • Auto-advance timer with a progress bar (pause with Space / click)
//  • Font-size slider that triggers live reflow + re-animation
//  • Keyboard navigation (← →)
//  • Live stats: layout µs, line count, container width

import { layoutWithLines, prepareWithSegments, type PreparedTextWithSegments } from '../../../src/layout.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Quotes data
// ─────────────────────────────────────────────────────────────────────────────

const QUOTES: { text: string; author: string }[] = [
  {
    text: 'We shape our tools and afterwards our tools shape us.',
    author: 'Marshall McLuhan',
  },
  {
    text: 'The best way to predict the future is to invent it.',
    author: 'Alan Kay',
  },
  {
    text: 'Simplicity is the ultimate sophistication.',
    author: 'Leonardo da Vinci',
  },
  {
    text: 'Any sufficiently advanced technology is indistinguishable from magic.',
    author: 'Arthur C. Clarke',
  },
  {
    text: 'Design is not just what it looks like and feels like. Design is how it works.',
    author: 'Steve Jobs',
  },
  {
    text: "A language that doesn't affect the way you think about programming is not worth knowing.",
    author: 'Alan J. Perlis',
  },
  {
    text: 'The art challenges the technology, and the technology inspires the art.',
    author: 'John Lasseter',
  },
  {
    text: 'Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.',
    author: 'Antoine de Saint-Exupéry',
  },
  {
    text: 'Programs must be written for people to read, and only incidentally for machines to execute.',
    author: 'Harold Abelson',
  },
  {
    text: 'The function of good software is to make the complex appear to be simple.',
    author: 'Grady Booch',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Canvas constellation background
// ─────────────────────────────────────────────────────────────────────────────

type Star = {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  alpha: number
}

const bgCanvas = document.getElementById('bg-canvas') as HTMLCanvasElement
const bgCtx = bgCanvas.getContext('2d')!
const STAR_COUNT = 90
const CONNECT_DIST = 120
const stars: Star[] = []

function initStars(): void {
  stars.length = 0
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * bgCanvas.width,
      y: Math.random() * bgCanvas.height,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: Math.random() * 1.4 + 0.4,
      alpha: Math.random() * 0.5 + 0.2,
    })
  }
}

function resizeBgCanvas(): void {
  bgCanvas.width = window.innerWidth
  bgCanvas.height = window.innerHeight
  initStars()
}

function tickStars(): void {
  const w = bgCanvas.width
  const h = bgCanvas.height
  bgCtx.clearRect(0, 0, w, h)

  // Draw connections
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const si = stars[i]!
      const sj = stars[j]!
      const dx = si.x - sj.x
      const dy = si.y - sj.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < CONNECT_DIST) {
        const alpha = (1 - d / CONNECT_DIST) * 0.12
        bgCtx.strokeStyle = `rgba(200,169,110,${alpha})`
        bgCtx.lineWidth = 0.6
        bgCtx.beginPath()
        bgCtx.moveTo(si.x, si.y)
        bgCtx.lineTo(sj.x, sj.y)
        bgCtx.stroke()
      }
    }
  }

  // Draw stars + move
  for (const s of stars) {
    bgCtx.beginPath()
    bgCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    bgCtx.fillStyle = `rgba(240,236,228,${s.alpha})`
    bgCtx.fill()

    s.x += s.vx
    s.y += s.vy
    if (s.x < 0) s.x = w
    else if (s.x > w) s.x = 0
    if (s.y < 0) s.y = h
    else if (s.y > h) s.y = 0
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────

const linesContainer = document.getElementById('lines-container')!
const attributionEl = document.getElementById('attribution')!
const navDotsEl = document.getElementById('nav-dots')!
const fontSlider = document.getElementById('font-slider') as HTMLInputElement
const fontSizeVal = document.getElementById('font-size-val')!
const statLines = document.getElementById('stat-lines')!
const statTime = document.getElementById('stat-time')!
const statWidth = document.getElementById('stat-width')!
const progressFill = document.getElementById('progress-fill')!
const pauseIcon = document.getElementById('pause-icon')!

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let currentIdx = 0
let fontSize = 34
let paused = false
let activeLineEls: HTMLElement[] = []
let prepareCache = new Map<string, PreparedTextWithSegments>()
let rafPending: number | null = null

// Auto-advance: each quote displays for QUOTE_DURATION ms
const QUOTE_DURATION = 7000
let quoteStartTime = 0

// ─────────────────────────────────────────────────────────────────────────────
// Nav dots
// ─────────────────────────────────────────────────────────────────────────────

function buildNavDots(): void {
  navDotsEl.innerHTML = ''
  for (let i = 0; i < QUOTES.length; i++) {
    const btn = document.createElement('button')
    btn.className = 'dot' + (i === currentIdx ? ' active' : '')
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-label', `Quote ${i + 1}`)
    btn.addEventListener('click', () => {
      goToQuote(i)
    })
    navDotsEl.appendChild(btn)
  }
}

function updateNavDots(): void {
  const dots = navDotsEl.querySelectorAll<HTMLButtonElement>('.dot')
  dots.forEach((d, i) => d.classList.toggle('active', i === currentIdx))
}

// ─────────────────────────────────────────────────────────────────────────────
// Font helpers
// ─────────────────────────────────────────────────────────────────────────────

function getFont(): string {
  return `${fontSize}px Georgia, "Times New Roman", serif`
}

function getLineHeight(): number {
  return Math.round(fontSize * 1.42)
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepare cache
// ─────────────────────────────────────────────────────────────────────────────

function getPrepared(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}\0${text}`
  let p = prepareCache.get(key)
  if (p === undefined) {
    p = prepareWithSegments(text, font)
    prepareCache.set(key, p)
  }
  return p
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout + render
// ─────────────────────────────────────────────────────────────────────────────

function getContainerWidth(): number {
  // Read once from DOM; no writes nearby so no forced reflow concern.
  const ww = document.getElementById('quote-wrapper')
  return ww ? ww.clientWidth : window.innerWidth - 64
}

function scheduleRender(): void {
  if (rafPending !== null) return
  rafPending = requestAnimationFrame(() => {
    rafPending = null
    renderQuote(false)
  })
}

function renderQuote(fromQuoteChange: boolean): void {
  const quote = QUOTES[currentIdx]
  if (quote === undefined) return

  const font = getFont()
  const lineHeight = getLineHeight()
  const containerWidth = getContainerWidth()
  if (containerWidth <= 0) return

  const prepared = getPrepared(quote.text, font)

  // ── Layout (pure arithmetic after prepare) ──────────────────
  const t0 = performance.now()
  const result = layoutWithLines(prepared, containerWidth, lineHeight)
  const elapsedUs = Math.round((performance.now() - t0) * 1000)

  // ── Stats ───────────────────────────────────────────────────
  statLines.textContent = String(result.lineCount)
  statTime.textContent = String(elapsedUs)
  statWidth.textContent = String(Math.round(containerWidth))

  // ── Container height (CSS transition smooths it) ─────────────
  linesContainer.style.height = `${result.height}px`

  // ── Fade out old lines ───────────────────────────────────────
  const outDelay = fromQuoteChange ? 0 : -1 // -1 means skip out-animation
  const oldEls = activeLineEls
  if (outDelay >= 0) {
    for (let i = 0; i < oldEls.length; i++) {
      const el = oldEls[i]!
      const delay = i * 30
      el.style.transitionDelay = `${delay}ms`
      el.style.transitionProperty = 'opacity, transform'
      el.style.transitionDuration = '180ms'
      el.style.transitionTimingFunction = 'ease'
      el.style.opacity = '0'
      el.style.transform = fromQuoteChange ? 'translateY(10px)' : 'translateY(0)'
    }
    setTimeout(() => {
      for (const el of oldEls) el.remove()
    }, 220 + oldEls.length * 30)
  } else {
    for (const el of oldEls) el.remove()
  }

  // ── Build new line elements ──────────────────────────────────
  const newEls: HTMLElement[] = []
  const inDelay = fromQuoteChange ? 200 + oldEls.length * 30 : 0

  for (let i = 0; i < result.lines.length; i++) {
    const line = result.lines[i]!

    const row = document.createElement('div')
    row.className = 'line-row'
    row.style.top = `${i * lineHeight}px`

    // Start invisible and slightly offset
    row.style.opacity = '0'
    row.style.transform = 'translateY(-10px)'
    row.style.transition = 'none'

    const textSpan = document.createElement('span')
    textSpan.className = 'line-text'
    textSpan.style.font = font
    textSpan.textContent = line.text
    row.appendChild(textSpan)

    // Width-fill bar
    const bar = document.createElement('span')
    bar.className = 'line-bar'
    const fillRatio = containerWidth > 0 ? line.width / containerWidth : 0
    bar.style.width = `${Math.round(fillRatio * containerWidth)}px`
    row.appendChild(bar)

    linesContainer.appendChild(row)
    newEls.push(row)

    // Stagger in — one micro-task tick so the initial styles commit first
    const staggerDelay = inDelay + i * 55
    setTimeout(() => {
      row.style.transition = 'opacity 320ms ease, transform 320ms cubic-bezier(0.22,0.61,0.36,1)'
      row.style.opacity = '1'
      row.style.transform = 'translateY(0)'
    }, staggerDelay)
  }

  activeLineEls = newEls

  // ── Attribution ──────────────────────────────────────────────
  if (fromQuoteChange) {
    attributionEl.classList.remove('visible')
    const attrDelay = inDelay + result.lines.length * 55 + 80
    setTimeout(() => {
      attributionEl.textContent = `— ${quote.author}`
      attributionEl.classList.add('visible')
    }, attrDelay)
  } else {
    // On resize just update text in place; attribution is already showing
    attributionEl.textContent = `— ${quote.author}`
    if (!attributionEl.classList.contains('visible')) {
      attributionEl.classList.add('visible')
    }
  }

  updateNavDots()
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

function goToQuote(idx: number, fromUser = true): void {
  if (idx === currentIdx && !fromUser) return
  currentIdx = ((idx % QUOTES.length) + QUOTES.length) % QUOTES.length
  quoteStartTime = performance.now()
  renderQuote(true)
}

function nextQuote(): void {
  goToQuote((currentIdx + 1) % QUOTES.length, false)
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress bar (auto-advance)
// ─────────────────────────────────────────────────────────────────────────────

function updateProgress(now: number): void {
  if (paused) {
    progressFill.style.transitionDuration = '0ms'
    return
  }
  const elapsed = now - quoteStartTime
  const pct = Math.min(100, (elapsed / QUOTE_DURATION) * 100)
  progressFill.style.transitionDuration = '200ms'
  progressFill.style.width = `${pct}%`

  if (elapsed >= QUOTE_DURATION) {
    progressFill.style.transitionDuration = '0ms'
    progressFill.style.width = '0%'
    nextQuote()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pause / resume
// ─────────────────────────────────────────────────────────────────────────────

const pauseStatusEl = document.getElementById('pause-status')!

function togglePause(): void {
  paused = !paused
  if (!paused) {
    // Resume — offset quoteStartTime so remaining time is preserved
    const pct = parseFloat(progressFill.style.width) || 0
    quoteStartTime = performance.now() - (pct / 100) * QUOTE_DURATION
  }
  pauseIcon.classList.toggle('show', paused)
  pauseStatusEl.textContent = paused ? 'Paused' : 'Resumed'
}

// ─────────────────────────────────────────────────────────────────────────────
// Main animation loop
// ─────────────────────────────────────────────────────────────────────────────

function loop(now: number): void {
  tickStars()
  updateProgress(now)
  requestAnimationFrame(loop)
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────────

fontSlider.addEventListener('input', () => {
  fontSize = parseInt(fontSlider.value, 10)
  fontSizeVal.textContent = `${fontSize}px`
  prepareCache.clear() // font changed → re-prepare with new size
  scheduleRender()
})

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') goToQuote((currentIdx + 1) % QUOTES.length)
  else if (e.key === 'ArrowLeft') goToQuote((currentIdx - 1 + QUOTES.length) % QUOTES.length)
  else if (e.key === ' ') {
    e.preventDefault()
    togglePause()
  }
})

document.getElementById('stage')!.addEventListener('click', e => {
  // Clicking the stage itself (not a control) toggles pause
  const target = e.target as Element
  if (target.closest('#controls') !== null) return
  if (target.closest('#nav-dots') !== null) return
  togglePause()
})

window.addEventListener('resize', () => {
  resizeBgCanvas()
  scheduleRender()
})

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

function boot(): void {
  resizeBgCanvas()
  buildNavDots()

  quoteStartTime = performance.now()

  // Initial render fires after fonts are ready for accurate measurements
  document.fonts.ready.then(() => {
    renderQuote(true)
  })

  requestAnimationFrame(loop)
}

boot()
