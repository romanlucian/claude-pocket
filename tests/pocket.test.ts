import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buttonFor, expandPath, fit } from '../hooks/screen'

const HOME = '/home/test'
const GAME = `${HOME}/Games/demo.gb`
const SOCKET = '/tmp/pocket-test/s'
const WEB = 'http://127.0.0.1:4567/?t=secret'
const VSCODE = { HOME, TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }
const GHOSTTY = { HOME, TERM: 'xterm-256color', GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app' }

const PANE = {
  plugin: 'pocket',
  component: 'Pane',
  requestId: 'pocket',
  props: {
    title: 'Pocket',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 70 },
    view: {},
  },
} as const

/**
 * Stands in for Node running the emulator, the file system and the screen.
 * The emulator says it is ready, then sends `lines` (a frame, a pause from
 * the game window), then idles until `release`.
 */
function fakeHost(on: On, env: Record<string, string>, lines: Record<string, unknown>[] = []) {
  const posts: { path: string; body: unknown }[] = []
  const blits: Record<string, unknown>[] = []
  const spawned: string[][] = []
  let isRunning = true
  let isImageDrawn = false

  mock.env(on, env)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_700_000_000_000 })

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield {
      stream: 'stdout' as const,
      text: `${JSON.stringify({ ready: true, socket: SOCKET, web: WEB, title: 'DEMO', width: 160, height: 144 })}\n`,
    }
    for (const line of lines) yield { stream: 'stdout' as const, text: `${JSON.stringify(line)}\n` }
    // Idle on the mocked clock, as a stream with nothing new does: the kit's
    // acts settle around a wait on its clock, never around one of the test's.
    while (isRunning) await clock.sleep(1000)
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  on('http.fetch', ($, e) => {
    posts.push({ path: new URL(e.url).pathname, body: JSON.parse(e.init?.body ?? '{}') })
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('fs.exists', ($, e) => ({ value: e.path === GAME }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.blit', ($, e) => {
    blits.push({ ...e })
    // As the engine answers a picture sent to a screen not yet drawn as one.
    if (!isImageDrawn) return { value: { deny: 'pocket has no Image keyed screen mounted there' } }
    return { value: {} }
  })
  const paths = () => posts.map(post => post.path)
  const release = () => {
    isRunning = false
  }
  const drawImage = () => {
    isImageDrawn = true
  }
  return { posts, paths, blits, spawned, clock, release, drawImage }
}

const command = (args: string) => ({
  command: 'pocket',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

const start = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('the helpers', () => {
  test('fit the picture to the pane', () => {
    expect(fit(200, 100)).toEqual({ columns: 96, rows: 44 })
    expect(fit(200, 30).rows).toBeLessThanOrEqual(30)
    expect(fit(40, 100).columns).toBe(40)
  })

  test('keys and paths', () => {
    expect(['up', 'z', 'X', 'return', ' ', 'p', 'q'].map(buttonFor)).toEqual(['up', 'a', 'b', 'start', 'select', 'pause', undefined])
    expect(expandPath(' "~/Games/demo.gb" ', HOME)).toBe(GAME)
  })
})

// While the emulator's stream is open, each act waits a moment for the
// engine to go quiet, so these tests need more than the default 5 seconds.
describe('the mod', () => {
  test('in VS Code, plays in its own window', { timeoutMs: 20000 }, async ($, on) => {
    const host = fakeHost(on, VSCODE, [{ paused: true }])
    await $.session.start(start)

    const answer = await $.command.run(command('~/Games/demo.gb'))
    expect(answer.text).toContain('in its own window')
    await host.clock.settle()
    expect(host.spawned[0]?.slice(-2)).toEqual([expect.stringMatching(/runner\/pocket\.mjs$/), GAME])
    // The game window opened, and the emulator draws no pictures for the pane.
    expect(host.paths()).toContain('/open')
    expect(host.paths()).not.toContain('/mode')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'in its own window' })).toBeDefined()
    expect(await ui.find({ key: 'screen' })).toBeUndefined()
    expect(await ui.find({ key: 'pad' })).toBeUndefined()

    // The game window's P paused it: the pane says so, and Resume goes on.
    expect(await ui.find({ type: 'Text', text: 'DEMO · paused' })).toBeDefined()
    await ui.press({ key: 'pause' })
    expect(host.paths()).toContain('/resume')
    expect(await ui.find({ type: 'Text', text: 'DEMO' })).toBeDefined()

    // Closed the window? Show it again.
    const opens = host.paths().filter(path => path === '/open').length
    await ui.press({ key: 'open' })
    expect(host.paths().filter(path => path === '/open').length).toBe(opens + 1)

    // The emulator quits on its own: the pane says so and offers to play again.
    host.release()
    await host.clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: 'The console stopped.' })).toBeDefined()
    expect(await ui.find({ key: 'restart' })).toBeDefined()
    await ui.unmount()
  })

  test('in Ghostty, plays in the pane with sharp pixels and pad keys', { timeoutMs: 20000 }, async ($, on) => {
    const host = fakeHost(on, GHOSTTY, [{ frame: 1, file: '/tmp/pocket-test/frame0.rgb' }])
    await $.session.start(start)
    const missing = await $.command.run(command('~/nope.gb'))
    expect(missing.text).toContain('There is no file')
    await $.command.run(command(GAME))
    await host.clock.settle()
    expect(host.posts).toContainEqual({ path: '/mode', body: { image: true } })
    expect(host.paths()).not.toContain('/open')

    // A refusal while the screen is not yet a picture keeps the pane.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    host.drawImage()
    expect((await ui.find({ key: 'screen' }))?.type).toBe('Image')
    expect(await ui.find({ type: 'Text', text: 'in this pane' })).toBeDefined()

    await ui.key({ key: 'right', in: 'pad' })
    await ui.key({ key: 'z', in: 'pad' })
    await ui.key({ key: 'q', in: 'pad' })
    const keys = host.posts.filter(post => post.path === '/keys').flatMap(post => (post.body as { keys: string[] }).keys)
    expect(keys).toEqual(['right', 'a'])

    await ui.key({ key: 'p', in: 'pad' })
    expect(host.paths()).toContain('/pause')
    expect(await ui.find({ type: 'Text', text: 'DEMO · paused' })).toBeDefined()

    // Play in a window instead: the choice opens it.
    await ui.press({ key: 'picture' })
    expect(host.posts).toContainEqual({ path: '/mode', body: { image: false } })
    expect(host.paths()).toContain('/open')
    expect(await ui.find({ key: 'screen' })).toBeUndefined()
    host.release()
    await host.clock.advance(1000)
    await ui.unmount()
  })

  test('pauses when Claude finishes a turn, not a subagent', { timeoutMs: 20000 }, async ($, on) => {
    const host = fakeHost(on, VSCODE)
    await $.session.start(start)
    await $.command.run(command(GAME))
    await host.clock.settle()

    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'sub', reason: 'answer' })
    expect(host.paths()).not.toContain('/pause')
    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(host.paths()).toContain('/pause')
    host.release()
    await host.clock.advance(1000)
  })
})
