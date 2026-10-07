// The game window: a small web page the emulator serves on this machine
// only (127.0.0.1), drawing each frame on a canvas with crisp pixels. A
// browser reports key releases, so its keys press and release the buttons
// exactly, unlike a terminal's.
//
// The page lives at a secret address (a random token in the URL); every
// request without it, or naming another host, is refused, so no other web
// page can drive the game.

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { SHADES, WIDTH, HEIGHT } from '../core/machine.mjs'

const BUTTONS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'])

/**
 * Starts the page's server. `onButton(button, isDown)` and `onPause()` (a
 * toggle) are the page's keys; resolves `{ url, hasViewers, frame(packed),
 * status({ isPaused }) }` once listening.
 */
export function startWeb({ title, onButton, onPause }) {
  const token = randomBytes(16).toString('hex')
  const viewers = new Set()
  let lastStatus = { isPaused: false }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const host = request.headers.host ?? ''
    const port = server.address().port
    if (url.searchParams.get('t') !== token || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      response.writeHead(403).end('Not this page.')
      return
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(page(title, token))
    } else if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      response.write(`event: status\ndata: ${JSON.stringify(lastStatus)}\n\n`)
      viewers.add(response)
      request.on('close', () => viewers.delete(response))
    } else if (request.method === 'POST' && url.pathname === '/button') {
      const button = url.searchParams.get('b') ?? ''
      if (BUTTONS.has(button)) onButton(button, url.searchParams.get('down') === '1')
      response.end('{}')
    } else if (request.method === 'POST' && url.pathname === '/pause') {
      onPause()
      response.end('{}')
    } else {
      response.writeHead(404).end()
    }
  })

  const broadcast = (event, data) => {
    for (const viewer of viewers) viewer.write(`event: ${event}\ndata: ${data}\n\n`)
  }

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/?t=${token}`,
        hasViewers: () => viewers.size > 0,
        frame: packed => broadcast('frame', Buffer.from(packed).toString('base64')),
        status: next => {
          lastStatus = next
          broadcast('status', JSON.stringify(next))
        },
        close: () => {
          // The console stopped: the page closes its window.
          for (const viewer of viewers) viewer.end('event: bye\ndata: {}\n\n')
          server.close()
        },
      })
    })
  })
}

const escapeHtml = text => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function page(title, token) {
  const shades = SHADES.map(c => [c >> 16, (c >> 8) & 255, c & 255])
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'Pocket')}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #16181c; color: #c9d1c3; font: 13px/1.4 ui-monospace, Menlo, monospace; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; }
  #frame { position: relative; flex: 1 1 auto; width: 100%; display: flex; align-items: center; justify-content: center; min-height: 0; }
  canvas { image-rendering: pixelated; image-rendering: crisp-edges; background: #e0f8d0; box-shadow: 0 0 0 6px #2a2f2a, 0 10px 40px #0008; }
  #note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  #note span { background: #081820e6; color: #e0f8d0; padding: 8px 14px; border-radius: 6px; font-size: 15px; }
  #keys { opacity: .7; text-align: center; }
  kbd { border: 1px solid #555; border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; }
</style>
</head>
<body>
<div id="frame"><canvas id="screen" width="${WIDTH}" height="${HEIGHT}"></canvas><div id="note"></div></div>
<div id="keys"><kbd>←↑→↓</kbd> move · <kbd>Z</kbd> A (jump) · <kbd>X</kbd> B · <kbd>Enter</kbd> Start · <kbd>Shift</kbd> Select · <kbd>P</kbd> pause</div>
<script>
const T = ${JSON.stringify(token)}
const SHADES = ${JSON.stringify(shades)}
const W = ${WIDTH}, H = ${HEIGHT}
const canvas = document.getElementById('screen')
const note = document.getElementById('note')
const ctx = canvas.getContext('2d')
const image = ctx.createImageData(W, H)

// The biggest whole-number scale that fits: every game pixel the same size.
function fit() {
  const box = document.getElementById('frame').getBoundingClientRect()
  const scale = Math.max(1, Math.floor(Math.min(box.width / W, box.height / H) * devicePixelRatio) / devicePixelRatio)
  canvas.style.width = W * scale + 'px'
  canvas.style.height = H * scale + 'px'
}
addEventListener('resize', fit)
// An app window opens at the size the browser picked: make it fit the game
// at four times its size (a tab ignores this).
if (window.outerWidth < W * 3) try { window.resizeTo(W * 4 + 40, H * 4 + 120) } catch {}
fit()

function say(text) {
  note.innerHTML = text ? '<span>' + text + '</span>' : ''
}

const events = new EventSource('/events?t=' + T)
events.addEventListener('frame', e => {
  const packed = Uint8Array.from(atob(e.data), c => c.charCodeAt(0))
  const px = image.data
  for (let i = 0; i < packed.length; i++) {
    const b = packed[i]
    for (let k = 0; k < 4; k++) {
      const s = SHADES[(b >> (k * 2)) & 3], o = (i * 4 + k) * 4
      px[o] = s[0]; px[o + 1] = s[1]; px[o + 2] = s[2]; px[o + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
})
events.addEventListener('status', e => say(JSON.parse(e.data).isPaused ? 'Paused · press P' : ''))
let isOver = false
events.addEventListener('bye', () => {
  isOver = true
  events.close()
  window.close()
  say('The console stopped. You can close this window.')
})
events.onerror = () => {
  if (!isOver) say('The console stopped. Run /pocket again in Claude Code.')
}

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', z: 'a', Z: 'a', x: 'b', X: 'b', Enter: 'start', Shift: 'select', Backspace: 'select' }
const down = new Set()
const post = path => fetch(path + (path.includes('?') ? '&' : '?') + 't=' + T, { method: 'POST' }).catch(() => {})
function setButton(button, isDown) {
  if (isDown === down.has(button)) return
  isDown ? down.add(button) : down.delete(button)
  post('/button?b=' + button + '&down=' + (isDown ? 1 : 0))
}
addEventListener('keydown', e => {
  if (e.key === 'p' || e.key === 'P') { if (!e.repeat) post('/pause'); e.preventDefault(); return }
  const button = KEYS[e.key]
  if (button) { setButton(button, true); e.preventDefault() }
})
addEventListener('keyup', e => {
  const button = KEYS[e.key]
  if (button) { setButton(button, false); e.preventDefault() }
})
// Leaving the window lets go of every button.
addEventListener('blur', () => { for (const button of [...down]) setButton(button, false) })
</script>
</body>
</html>`
}
