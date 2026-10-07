#!/usr/bin/env node
// The emulator process the mod starts: `node pocket.mjs <game file>`.
//
// It runs the game in real time and talks to the mod through:
// - stdout, one JSON line per message: first `{"ready":…}`, then, in image
//   mode, one `{"frame":…}` per picture naming the RGB file the terminal
//   reads;
// - a tiny HTTP server on a Unix socket in a private temp folder, for keys
//   (`POST /keys`), pause (`POST /pause`, `POST /resume`), the drawing
//   mode (`POST /mode`) and opening the game window (`POST /open`);
// - the game window, a web page on 127.0.0.1 (web.mjs): its address is in
//   the ready line, and a pause from it is a `{"paused":…}` line.
//
// A game that saves (battery RAM) keeps its save in `<game>.sav` beside the
// game file, the name other emulators use: read at the start, written a
// second after the game changes it, and when the console stops.
//
// A terminal reports key presses but not releases, so a press holds the
// button for a moment and each repeat of a held key extends the hold.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
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

const savePath = machine.hasSave ? romPath.replace(/\.(gb|gbc|dmg)$/i, '') + '.sav' : null
let isSaveLoaded = false
if (savePath !== null && existsSync(savePath)) {
  try {
    machine.loadSave(new Uint8Array(readFileSync(savePath)))
    isSaveLoaded = true
  } catch (error) {
    send({ warning: `Could not read the save ${savePath}: ${error.message}` })
  }
}
let isSaveWarned = false

// Writes the save if the game changed it: whole, then named, so a crash
// never leaves half a save.
function writeSave() {
  const bytes = machine.takeSave()
  if (bytes === null || savePath === null) return
  try {
    writeFileSync(`${savePath}.tmp`, bytes)
    renameSync(`${savePath}.tmp`, savePath)
  } catch (error) {
    if (!isSaveWarned) send({ warning: `Could not write the save ${savePath}: ${error.message}` })
    isSaveWarned = true
  }
}

const dir = mkdtempSync(join(tmpdir(), 'pocket-'))
const socket = join(dir, 's')
let isPaused = false
let imageMode = false
let imageSlot = 0
let generation = 0
const heldUntil = new Map()
// Buttons the game window holds down, and since when: a browser reports
// the release. The shortest press the game is sure to see: two frames.
const webDown = new Map()
const MIN_TAP_MS = 2 * FRAME_MS

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
    const now = performance.now()
    if (isDown) {
      webDown.set(button, now)
      machine.setButton(button, true)
      return
    }
    // A tap quicker than a frame or two would be missed: keep it down that long.
    const downAt = webDown.get(button)
    webDown.delete(button)
    const release = () => {
      if (webDown.has(button)) return
      const until = heldUntil.get(button)
      machine.setButton(button, until !== undefined && until > performance.now())
    }
    const heldFor = downAt === undefined ? Infinity : now - downAt
    if (heldFor >= MIN_TAP_MS) release()
    else setTimeout(release, MIN_TAP_MS - heldFor)
  },
  onPause: () => setPaused(!isPaused),
})

// Browsers that open a page as a clean app window (`--app`): no tabs, no
// address bar. Without one, the default browser opens it in a tab.
const APP_BROWSERS = {
  darwin: ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Arc'].flatMap(name => [
    `/Applications/${name}.app`,
    join(homedir(), 'Applications', `${name}.app`),
  ]),
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'],
}
// Four times the game's size, plus the window's own frame and the key line.
const WINDOW_SIZE = `${WIDTH * 4 + 40},${HEIGHT * 4 + 120}`

function launch(command, args) {
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.on('error', () => resolve(false))
      child.on('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

// Opens the game window: an app window of a Chromium browser if there is
// one, else the default browser.
async function openPage() {
  const appArgs = [`--app=${web.url}`, `--window-size=${WINDOW_SIZE}`]
  if (process.platform === 'darwin') {
    const app = APP_BROWSERS.darwin.find(path => existsSync(path))
    if (app !== undefined && (await launch('open', ['-na', app, '--args', ...appArgs]))) return
    await launch('open', [web.url])
  } else if (process.platform === 'win32') {
    if (await launch('cmd', ['/c', 'start', '', 'chrome', ...appArgs])) return
    await launch('cmd', ['/c', 'start', '', web.url])
  } else {
    for (const browser of APP_BROWSERS.linux) if (await launch(browser, appArgs)) return
    await launch('xdg-open', [web.url])
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
  }
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
      void openPage()
    } else if (request.url === '/mode') {
      imageMode = data.image === true
    }
    response.end(JSON.stringify({ isPaused, imageMode }))
  })
})

server.listen(socket, () =>
  send({ ready: true, socket, web: web.url, title: machine.title, width: WIDTH, height: HEIGHT, save: savePath, isSaveLoaded }),
)

// Real time: run as many frames as the clock says are due (at most a few,
// so a stall does not fast-forward), and send only the newest picture.
let due = performance.now()
let framesSinceSave = 0
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
    // The sound of those frames, for the game window (always taken, so it
    // never piles up).
    const sound = machine.apu.take()
    if (sound.length > 0 && web.hasViewers()) web.sound(sound)
    framesSinceSave += frames
    if (framesSinceSave >= 60) {
      framesSinceSave = 0
      writeSave()
    }
  }
  setTimeout(loop, Math.max(1, due - performance.now()))
}
loop()

const stop = () => {
  writeSave()
  server.close()
  web.close()
  cleanUp()
  // A moment for the game window to hear goodbye and close itself.
  setTimeout(() => process.exit(0), 150).unref()
  isPaused = true
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('SIGHUP', stop)
// The mod is gone when our output pipe closes.
process.stdout.on('error', stop)
process.on('exit', cleanUp)
