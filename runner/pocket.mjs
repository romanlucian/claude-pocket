#!/usr/bin/env node
// The emulator process the mod starts: `node pocket.mjs <game file>`.
//
// It runs the game in real time and talks to the mod through:
// - stdout, one JSON line per message: first `{"ready":…}`, then one
//   `{"frame":…}` per picture (the 160x144 shades packed 4 per byte, base64;
//   in image mode the RGB file the terminal should read instead);
// - a tiny HTTP server on a Unix socket in a private temp folder, for keys
//   (`POST /keys`), pause (`POST /pause`, `POST /resume`), the drawing
//   mode (`POST /mode`) and opening the sharp screen (`POST /open`);
// - the sharp screen, a web page on 127.0.0.1 (web.mjs): its address is in
//   the ready line, and a pause from it is a `{"paused":…}` line.
//
// A terminal reports key presses but not releases, so a press holds the
// button for a moment and each repeat of a held key extends the hold.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Machine, SHADES, WIDTH, HEIGHT } from '../core/machine.mjs'
import { startWeb } from './web.mjs'

const FRAME_MS = 1000 / 59.7275
const FIRST_HOLD_MS = Number(process.env.POCKET_FIRST_HOLD_MS ?? 420)
const REPEAT_HOLD_MS = Number(process.env.POCKET_REPEAT_HOLD_MS ?? 140)

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

const romPath = process.argv[2]
if (!romPath) {
  send({ error: 'Give the game file to play: pocket.mjs <file.gb>' })
  process.exit(2)
}

let machine
try {
  machine = new Machine(new Uint8Array(readFileSync(romPath)))
} catch (error) {
  send({ error: `Could not load ${romPath}: ${error.message}` })
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'pocket-'))
const socket = join(dir, 's')
let isPaused = false
let imageMode = false
let imageSlot = 0
let generation = 0
const heldUntil = new Map()
// Buttons the sharp screen holds down: a browser reports the release.
const webDown = new Set()

const cleanUp = () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // already gone
  }
}

function press(button, now) {
  const until = heldUntil.get(button)
  const isHeld = until !== undefined && until > now
  heldUntil.set(button, now + (isHeld ? REPEAT_HOLD_MS : FIRST_HOLD_MS))
}

function updateButtons(now) {
  for (const [button, until] of heldUntil) {
    const isDown = until > now
    machine.setButton(button, isDown || webDown.has(button))
    if (!isDown) heldUntil.delete(button)
  }
}

function setPaused(next) {
  if (next === isPaused) return
  isPaused = next
  web.status({ isPaused })
  send({ paused: isPaused })
}

const web = await startWeb({
  title: machine.title,
  onButton: (button, isDown) => {
    if (isDown) webDown.add(button)
    else webDown.delete(button)
    const until = heldUntil.get(button)
    machine.setButton(button, isDown || (until !== undefined && until > performance.now()))
  },
  onPause: () => setPaused(!isPaused),
})

// Opens the sharp screen in the default browser.
function openPage() {
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', web.url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', web.url] : ['xdg-open', web.url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {
    // no browser to open: the address is in the pane
  }
}

const packed = new Uint8Array((WIDTH * HEIGHT) / 4)
const rgb = new Uint8Array(WIDTH * HEIGHT * 3)

function pack(frame) {
  for (let i = 0; i < packed.length; i++) {
    const p = i * 4
    packed[i] = frame[p] | (frame[p + 1] << 2) | (frame[p + 2] << 4) | (frame[p + 3] << 6)
  }
}

function emit(frame) {
  generation++
  if (web.hasViewers()) {
    pack(frame)
    web.frame(packed)
  }
  if (imageMode) {
    for (let i = 0; i < frame.length; i++) {
      const color = SHADES[frame[i]]
      rgb[i * 3] = color >> 16
      rgb[i * 3 + 1] = (color >> 8) & 0xff
      rgb[i * 3 + 2] = color & 0xff
    }
    // Two files in turn, each written whole before it is named, so the
    // terminal never reads half a picture.
    imageSlot ^= 1
    const file = join(dir, `frame${imageSlot}.rgb`)
    writeFileSync(`${file}.tmp`, rgb)
    renameSync(`${file}.tmp`, file)
    send({ frame: generation, file })
    return
  }
  pack(frame)
  send({ frame: generation, px: Buffer.from(packed).toString('base64') })
}

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => (body += chunk))
  request.on('end', () => {
    let data = {}
    try {
      data = body ? JSON.parse(body) : {}
    } catch {
      // ignore a bad body
    }
    if (request.url === '/keys' && Array.isArray(data.keys)) {
      const now = performance.now()
      for (const button of data.keys) if (typeof button === 'string') press(button, now)
    } else if (request.url === '/pause') {
      setPaused(true)
    } else if (request.url === '/resume') {
      setPaused(false)
    } else if (request.url === '/open') {
      openPage()
    } else if (request.url === '/mode') {
      imageMode = data.image === true
    }
    response.end(JSON.stringify({ isPaused, imageMode }))
  })
})

server.listen(socket, () => send({ ready: true, socket, web: web.url, title: machine.title, width: WIDTH, height: HEIGHT }))

// Real time: run as many frames as the clock says are due (at most a few,
// so a stall does not fast-forward), and send only the newest picture.
let due = performance.now()
function loop() {
  const now = performance.now()
  if (isPaused) {
    due = now
  } else {
    let frames = 0
    while (due <= now && frames < 4) {
      updateButtons(due)
      machine.runFrame()
      due += FRAME_MS
      frames++
    }
    if (due < now) due = now
    if (frames > 0) emit(machine.frame)
  }
  setTimeout(loop, Math.max(1, due - performance.now()))
}
loop()

const stop = () => {
  server.close()
  web.close()
  cleanUp()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('SIGHUP', stop)
// The mod is gone when our output pipe closes.
process.stdout.on('error', stop)
process.on('exit', cleanUp)
