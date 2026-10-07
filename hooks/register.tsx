import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PocketGame } from '../types'
import { expandPath, fit, HEIGHT, WIDTH } from './screen'
import type { Fit } from './screen'

type Engine = EngineInterface

const PANE = 'pocket'
// Rows the pane keeps for everything but the screen: title, pad, buttons, message.
const CHROME_ROWS = 6

const game = atom({ plugin: 'pocket', key: 'game' } as const, {
  status: 'idle',
  title: '',
  romPath: '',
  message: '',
  firstFile: '',
  webUrl: '',
})
const mode = atom({ plugin: 'pocket', key: 'mode' } as const, 'window')
const pauseWhenDone = atom({ plugin: 'pocket', key: 'pauseWhenDone' } as const, true)

// How to run Node: the `nodePath` option, read again at every load.
let node = 'node'

// The running emulator. Module state on purpose: a reload ends the process.
type Runner = {
  stop: () => void
  socket?: string
  latestFile?: string
  generation: number
  lastSeq: number
  isShowing: boolean
}
let runner: Runner | undefined
// The box the screen was last drawn in: what a blit must match.
let pixelsBox: Fit = fit(80, 40)
// Whether the last drawing mounted the screen as an Image: only then may a
// blit swap its source (one sent before it is drawn is refused).
let isImageMounted = false

async function setGame($: Engine, change: Partial<PocketGame>): Promise<void> {
  await update($, game, current => ({ ...current, ...change }))
}

async function control($: Engine, path: string, body: unknown = {}): Promise<boolean> {
  const socket = runner?.socket
  if (socket === undefined) return false
  try {
    const answer = await $.http.fetch(`http://pocket${path}`, {
      method: 'POST',
      socketPath: socket,
      body: JSON.stringify(body),
    })
    return answer.ok
  } catch {
    return false
  }
}

async function stopGame($: Engine, message = 'Stopped.'): Promise<void> {
  const current = runner
  runner = undefined
  current?.stop()
  await update($, game, value => (value.status === 'idle' ? value : { ...value, status: 'idle' as const, message, firstFile: '', webUrl: '' }))
}

async function setPaused($: Engine, isPaused: boolean, message: string): Promise<void> {
  if (runner === undefined) return
  if (await control($, isPaused ? '/pause' : '/resume')) {
    await setGame($, { status: isPaused ? 'paused' : 'running', message })
  }
}

// Paints the newest picture into the mounted screen, without a redraw.
async function show($: Engine): Promise<void> {
  const current = runner
  if (current === undefined || current.isShowing || current.latestFile === undefined || !isImageMounted) return
  current.isShowing = true
  try {
    const done = await $.ui.blit({
      requestId: PANE,
      key: 'screen',
      source: { file: current.latestFile, format: 'rgb', width: WIDTH, height: HEIGHT, generation: current.generation },
    })
    // The Image draws its alt here: this terminal shows no pictures, or
    // cannot read the file. Any other refusal (a redraw in between) passes.
    if (done.deny !== undefined && /\balt\b|placeholder|cannot read/i.test(done.deny)) {
      await setMode($, 'window')
      await setGame($, { message: `This terminal shows no pictures (${done.deny}), so the game plays in its own window.` })
      await control($, '/open')
    }
  } finally {
    current.isShowing = false
  }
}

// Switches where the game is drawn, for this game and the next ones:
// `pixels` in the pane (Ghostty, kitty), `window` in its own window.
async function setMode($: Engine, drawing: 'pixels' | 'window'): Promise<void> {
  await $.store.set('mode', drawing)
  if (runner !== undefined) runner.latestFile = undefined
  await setGame($, { firstFile: '', message: '' })
  await update($, mode, () => drawing)
  await control($, '/mode', { image: drawing === 'pixels' })
  if (drawing === 'window') await control($, '/open')
}

async function startGame($: Engine, romPath: string): Promise<void> {
  await stopGame($)
  await setGame($, { status: 'starting', title: '', romPath, message: 'Starting the console…', firstFile: '', webUrl: '' })
  const stream = $.process.spawn({ argv: [node, `${$.plugin.root}/runner/pocket.mjs`, romPath] })
  const mine: Runner = {
    stop: () => void stream.return({ code: null, signal: 'SIGTERM' }),
    generation: 0,
    lastSeq: 0,
    isShowing: false,
  }
  runner = mine
  void pump($, stream, mine)
}

async function pump(
  $: Engine,
  stream: AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>,
  mine: Runner,
): Promise<void> {
  let pending = ''
  let errors = ''
  let failure: string | undefined
  try {
    for await (const chunk of stream) {
      if (runner !== mine) break
      if (chunk.stream === 'stderr') {
        errors = (errors + chunk.text).slice(-2000)
        continue
      }
      pending += chunk.text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (typeof message.error === 'string') failure = message.error
        if (message.ready === true && typeof message.socket === 'string') {
          mine.socket = message.socket
          const title = typeof message.title === 'string' && message.title !== '' ? message.title : 'Game'
          const webUrl = typeof message.web === 'string' ? message.web : ''
          const drawing = await read($, mode)
          if (drawing === 'pixels') await control($, '/mode', { image: true })
          await setGame($, { status: 'running', title, message: '', webUrl })
          if (drawing === 'window') await control($, '/open')
        }
        if (typeof message.paused === 'boolean') {
          // The game window's P key paused or resumed the game.
          const isPaused = message.paused
          await update($, game, value =>
            value.status === 'running' || value.status === 'paused'
              ? { ...value, status: isPaused ? ('paused' as const) : ('running' as const), message: '' }
              : value,
          )
        }
        if (typeof message.frame === 'number') {
          mine.generation = message.frame
          if (typeof message.file === 'string') {
            mine.latestFile = message.file
            const { value: current } = await $.state.get({ plugin: 'pocket', key: 'game' })
            if (current?.firstFile === '') await setGame($, { firstFile: message.file })
          }
        }
      }
      await show($)
    }
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error)
  }
  if (runner !== mine) return
  runner = undefined
  const why = failure ?? (errors.trim().split('\n').pop() || 'The console stopped.')
  try {
    await setGame($, { status: 'error', message: why, firstFile: '', webUrl: '' })
  } catch {
    // The session or the mod is gone: nothing left to tell.
  }
}

async function sendKeys($: Engine, data: unknown): Promise<void> {
  const current = runner
  if (current === undefined) return
  const recent = (data as { recent?: unknown }).recent
  if (!Array.isArray(recent)) return
  const buttons: string[] = []
  let isPauseToggled = false
  for (const press of recent as { seq?: unknown; button?: unknown }[]) {
    if (typeof press.seq !== 'number' || typeof press.button !== 'string' || press.seq <= current.lastSeq) continue
    current.lastSeq = press.seq
    if (press.button === 'pause') isPauseToggled = true
    else buttons.push(press.button)
  }
  if (isPauseToggled) {
    const { status } = await read($, game)
    await setPaused($, status !== 'paused', status === 'paused' ? '' : 'Paused. Press P or Resume to go on.')
  }
  if (buttons.length > 0) await control($, '/keys', { keys: buttons })
}

async function openPane($: Engine): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Pocket' })
}

async function remember($: Engine, romPath: string): Promise<void> {
  await $.store.set('lastRom', romPath)
}

async function chooseMode($: Engine): Promise<void> {
  // The person's own choice (the Picture button) wins.
  const chosen = await $.store.get('mode')
  if (chosen === 'pixels' || chosen === 'window') {
    await update($, mode, () => chosen)
    return
  }
  const term = (await $.env.get('TERM')) ?? ''
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  const isKitty = (await $.env.get('KITTY_WINDOW_ID')) !== undefined
  const isGhostty = (await $.env.get('GHOSTTY_RESOURCES_DIR')) !== undefined
  const canDraw = isKitty || isGhostty || /kitty|ghostty/i.test(term) || /ghostty|kitty/i.test(program)
  await update($, mode, () => (canDraw ? 'pixels' : 'window'))
}

async function play($: Engine, args: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  let romPath = args === '' ? '' : expandPath(args, home)
  if (romPath === '') {
    const saved = await $.store.get('lastRom')
    romPath = typeof saved === 'string' ? saved : ''
  }
  await openPane($)
  if (romPath === '') {
    if (runner !== undefined) return 'Pocket is open.'
    return 'Give it your game file, for example: /pocket ~/Games/my-game.gb'
  }
  if (!(await $.fs.exists(romPath))) return `There is no file at ${romPath}.`
  await remember($, romPath)
  await startGame($, romPath)
  return (await read($, mode)) === 'window'
    ? `Starting ${romPath} in its own window.`
    : `Starting ${romPath}. Click the pad line in the Pocket pane to play.`
}

export const register: Register = (on, options) => {
  const configured = typeof options.nodePath === 'string' ? options.nodePath.trim() : ''
  node = configured === '' ? 'node' : configured

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pocket',
      description: 'Play your own handheld game files in a Claude Code pane',
      argumentHint: '<game file .gb> | stop',
    })
    await chooseMode($)
    return next(e)
  })

  on('command.run', { command: 'pocket' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'stop') {
      await stopGame($)
      return { text: 'Pocket stopped.' }
    }
    return { text: await play($, args) }
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId === PANE && e.element === 'pad') await sendKeys($, e.data)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await stopGame($, 'Closed.')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn is not Claude finishing.
    if (e.agentId !== undefined) return result
    const { status } = await read($, game)
    if (status === 'running' && (await read($, pauseWhenDone))) {
      await setPaused($, true, 'Claude finished, so the game paused. Press P or Resume.')
      $.ui.toast('pocket: Claude finished. Your game is paused.')
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Image = 'Image' in table ? table.Image : undefined
    const Client = 'Client' in table ? table.Client : undefined

    const current = await read($, game)
    const drawing = await read($, mode)
    const isPausing = await read($, pauseWhenDone)
    const isPlaying = current.status === 'running' || current.status === 'paused'
    const inPane = isPlaying && drawing === 'pixels'
    const freeRows = Math.max(10, e.props.scroll.bodyRows - CHROME_ROWS)
    const columns = Math.max(16, e.props.bodyColumns)

    let screen = null
    isImageMounted = false
    if (inPane && Image !== undefined && current.firstFile !== '') {
      pixelsBox = fit(columns, freeRows)
      isImageMounted = true
      screen = (
        <Image
          key="screen"
          source={{ file: current.firstFile, format: 'rgb', width: WIDTH, height: HEIGHT }}
          columns={pixelsBox.columns}
          rows={pixelsBox.rows}
          alt="The game screen"
        />
      )
    }

    const statusLine =
      current.status === 'idle'
        ? 'No game running.'
        : current.status === 'starting'
          ? 'Starting…'
          : current.status === 'error'
            ? 'The console stopped.'
            : `${current.title}${current.status === 'paused' ? ' · paused' : ''}`

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>{statusLine}</Text>
          {isPlaying && <Text dimColor>{inPane ? 'in this pane' : 'in its own window'}</Text>}
        </Box>
        {screen}
        {inPane && Client !== undefined && (
          <Client key="pad" module="./pad.tsx" props={{ isPaused: current.status === 'paused' }} height={1} />
        )}
        <Box gap={1} flexWrap="wrap">
          {isPlaying && (
            <Button
              key="pause"
              label={current.status === 'paused' ? 'Resume' : 'Pause'}
              onPress={() => void setPaused($, current.status !== 'paused', '')}
            />
          )}
          {current.romPath !== '' && (
            <Button key="restart" label={isPlaying ? 'Restart' : 'Play again'} onPress={() => void startGame($, current.romPath)} />
          )}
          {isPlaying && <Button key="stop" label="Stop" onPress={() => void stopGame($)} />}
          {isPlaying && !inPane && <Button key="open" label="Show game window" onPress={() => void control($, '/open')} />}
          {isPlaying && (
            <Button
              key="picture"
              label={inPane ? 'Play in a window' : 'Play in this pane'}
              onPress={() => void setMode($, inPane ? 'window' : 'pixels')}
            />
          )}
          <Button
            key="auto-pause"
            label={isPausing ? 'Pause when Claude finishes: on' : 'Pause when Claude finishes: off'}
            onPress={() => void update($, pauseWhenDone, value => !value)}
          />
        </Box>
        {current.message !== '' && <Text dimColor>{current.message}</Text>}
        {isPlaying && !inPane && (
          <Text dimColor>
            Play in the game window: ←↑→↓ move · Z = A · X = B · Enter = Start · Shift = Select · P = pause. Closed it? Show
            game window.
          </Text>
        )}
        {!isPlaying && current.romPath === '' && (
          <Text dimColor>Type /pocket and the path of your own game file, for example /pocket ~/Games/my-game.gb</Text>
        )}
      </Box>
    )
  })
}
