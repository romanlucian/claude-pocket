import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PocketGame } from '../types'
import { blank, expandPath, fit, toCells, unpack, HEIGHT, WIDTH } from './screen'
import type { Fit } from './screen'

type Engine = EngineInterface

const PANE = 'pocket'
// Rows the pane keeps for everything but the screen: title, pad, buttons, message.
const CHROME_ROWS = 6
// Rows of cells the whole picture takes, two pixels to a cell.
const FULL_ROWS = HEIGHT / 2
// Below this width the picture is too small to play well: say how to grow it.
const SMALL_COLUMNS = 80
// Cells mode encodes every picture in this module: at most this many a second.
const CELLS_FPS = 30

const game = atom({ plugin: 'pocket', key: 'game' } as const, {
  status: 'idle',
  title: '',
  romPath: '',
  message: '',
  firstFile: '',
})
const mode = atom({ plugin: 'pocket', key: 'mode' } as const, 'cells')
const pauseWhenDone = atom({ plugin: 'pocket', key: 'pauseWhenDone' } as const, true)

// How to run Node: the `nodePath` option, read again at every load.
let node = 'node'

// The running emulator. Module state on purpose: a reload ends the process.
type Runner = {
  stop: () => void
  socket?: string
  latestPx?: string
  latestFile?: string
  generation: number
  lastSeq: number
  isShowing: boolean
  lastShownAt: number
}
let runner: Runner | undefined
// The box the screen was last drawn in, per mode: what a blit must match.
let cellsBox: Fit = fit('cells', 80, 40)
let pixelsBox: Fit = fit('pixels', 80, 40)
let latestShades: Uint8Array = blank()

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
  await update($, game, value => (value.status === 'idle' ? value : { ...value, status: 'idle' as const, message, firstFile: '' }))
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
  if (current === undefined || current.isShowing) return
  current.isShowing = true
  try {
    const drawing = await read($, mode)
    if (drawing === 'pixels' && current.latestFile !== undefined) {
      const done = await $.ui.blit({
        requestId: PANE,
        key: 'screen',
        source: { file: current.latestFile, format: 'rgb', width: WIDTH, height: HEIGHT, generation: current.generation },
      })
      // This terminal shows no pictures (or cannot read the file): use cells.
      if (done.deny !== undefined && /alt|read|picture|image/i.test(done.deny)) {
        await useCells($, done.deny)
      }
    } else if (drawing === 'cells' && current.latestPx !== undefined) {
      const now = Date.now()
      if (now - current.lastShownAt < 1000 / CELLS_FPS) return
      current.lastShownAt = now
      latestShades = unpack(current.latestPx)
      current.latestPx = undefined
      await $.ui.blit({
        requestId: PANE,
        key: 'screen',
        cells: toCells(latestShades, cellsBox),
        columns: cellsBox.columns,
        rows: cellsBox.rows,
      })
    }
  } finally {
    current.isShowing = false
  }
}

async function useCells($: Engine, why: string): Promise<void> {
  await update($, mode, () => 'cells')
  await control($, '/mode', { image: false })
  $.ui.log(`pocket: drawing with cells, since this terminal shows no pictures here (${why})`, { to: 'debug' })
}

async function startGame($: Engine, romPath: string): Promise<void> {
  await stopGame($)
  await setGame($, { status: 'starting', title: '', romPath, message: 'Starting the console…', firstFile: '' })
  const stream = $.process.spawn({ argv: [node, `${$.plugin.root}/runner/pocket.mjs`, romPath] })
  const mine: Runner = {
    stop: () => void stream.return({ code: null, signal: 'SIGTERM' }),
    generation: 0,
    lastSeq: 0,
    isShowing: false,
    lastShownAt: 0,
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
          if ((await read($, mode)) === 'pixels') await control($, '/mode', { image: true })
          await setGame($, { status: 'running', title, message: '' })
        }
        if (typeof message.frame === 'number') {
          mine.generation = message.frame
          if (typeof message.px === 'string') mine.latestPx = message.px
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
    await setGame($, { status: 'error', message: why, firstFile: '' })
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
  // Ask for room for the full picture: 160 columns by 72 rows of cells (two
  // pixels a cell), plus the pane's own lines. The surface gives what it can.
  await $.ui.open({ id: PANE, title: 'Pocket', rows: FULL_ROWS + CHROME_ROWS, columns: WIDTH + 2 })
}

async function remember($: Engine, romPath: string): Promise<void> {
  await $.store.set('lastRom', romPath)
}

async function chooseMode($: Engine): Promise<void> {
  const term = (await $.env.get('TERM')) ?? ''
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  const isKitty = (await $.env.get('KITTY_WINDOW_ID')) !== undefined
  const canDraw = isKitty || /kitty|ghostty/i.test(term) || /ghostty/i.test(program)
  await update($, mode, () => (canDraw ? 'pixels' : 'cells'))
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
  return `Starting ${romPath}. Click the pad line in the Pocket pane to play.`
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
    const Raster = 'Raster' in table ? table.Raster : undefined
    const Image = 'Image' in table ? table.Image : undefined
    const Client = 'Client' in table ? table.Client : undefined

    const current = await read($, game)
    const drawing = await read($, mode)
    const isPausing = await read($, pauseWhenDone)
    const isPlaying = current.status === 'running' || current.status === 'paused'
    const freeRows = Math.max(10, e.props.scroll.bodyRows - CHROME_ROWS)
    const columns = Math.max(16, e.props.bodyColumns)

    let screen
    if (!isPlaying) {
      screen = null
    } else if (drawing === 'pixels' && Image !== undefined && current.firstFile !== '') {
      pixelsBox = fit('pixels', columns, freeRows)
      screen = (
        <Image
          key="screen"
          source={{ file: current.firstFile, format: 'rgb', width: WIDTH, height: HEIGHT }}
          columns={pixelsBox.columns}
          rows={pixelsBox.rows}
          alt="The game screen"
        />
      )
    } else if (Raster !== undefined) {
      cellsBox = fit('cells', columns, freeRows)
      screen = <Raster key="screen" columns={cellsBox.columns} rows={cellsBox.rows} cells={toCells(latestShades, cellsBox)} />
    } else {
      screen = <Text dimColor>The screen shows in a terminal: run Claude Code in Ghostty, kitty or VS Code's terminal.</Text>
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
          {isPlaying && <Text dimColor>{drawing === 'pixels' ? 'sharp pixels' : 'cell pixels'}</Text>}
        </Box>
        {screen}
        {isPlaying && Client !== undefined && (
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
          {isPlaying && drawing === 'cells' && (
            <Button key="fit" label="Fit" onPress={() => $.ui.invalidate('ui.render')} />
          )}
          <Button
            key="auto-pause"
            label={isPausing ? 'Pause when Claude finishes: on' : 'Pause when Claude finishes: off'}
            onPress={() => void update($, pauseWhenDone, value => !value)}
          />
        </Box>
        {current.message !== '' && <Text dimColor>{current.message}</Text>}
        {isPlaying && drawing === 'cells' && cellsBox.columns < SMALL_COLUMNS && (
          <Text color="warning">
            The pane is small for a clear picture: drag it taller (or make the font smaller, Cmd/Ctrl −), then press Fit.
          </Text>
        )}
        {!isPlaying && current.romPath === '' && (
          <Text dimColor>Type /pocket and the path of your own game file, for example /pocket ~/Games/my-game.gb</Text>
        )}
      </Box>
    )
  })
}
