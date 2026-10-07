import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buttonFor, expandPath, fit, toCells, unpack, HEIGHT, SHADES, WIDTH } from '../hooks/screen'

const HOME = '/home/test'
const GAME = `${HOME}/Games/demo.gb`
const SOCKET = '/tmp/pocket-test/s'

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

// A frame as the emulator packs it: shade = (x >> 3) & 3, stripes 8 px wide.
function stripes(): string {
  const bytes = new Uint8Array((WIDTH * HEIGHT) / 4)
  for (let i = 0; i < bytes.length; i++) {
    let b = 0
    for (let k = 0; k < 4; k++) b |= ((((i * 4 + k) % WIDTH) >> 3) & 3) << (k * 2)
    bytes[i] = b
  }
  return bytes.toBase64()
}

/** Stands in for Node running the emulator, the file system and the screen. */
function fakeHost(on: On, env: Record<string, string> = { HOME, TERM: 'xterm-256color' }) {
  const posts: { path: string; body: unknown }[] = []
  const blits: Record<string, unknown>[] = []
  const spawned: string[][] = []
  let isRunning = true
  const release = () => {
    isRunning = false
  }

  mock.env(on, env)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_700_000_000_000 })

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield {
      stream: 'stdout' as const,
      text: `${JSON.stringify({ ready: true, socket: SOCKET, title: 'DEMO', width: 160, height: 144 })}\n`,
    }
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ frame: 1, px: stripes() })}\n` }
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
    return { value: {} }
  })
  return { posts, blits, spawned, clock, release }
}

const command = (args: string) => ({
  command: 'pocket',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

const start = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('the screen', () => {
  test('unpacks frames, fits the pane and draws half-block cells', () => {
    const shades = unpack(stripes())
    expect(shades.length).toBe(WIDTH * HEIGHT)
    expect([shades[0], shades[8], shades[16], shades[24], shades[32]]).toEqual([0, 1, 2, 3, 0])

    expect(fit('cells', 200, 100)).toEqual({ columns: 160, rows: 72 })
    const narrow = fit('cells', 80, 100)
    expect(narrow.columns).toBe(80)
    expect(narrow.rows).toBe(36)
    expect(fit('cells', 200, 30).rows).toBeLessThanOrEqual(30)
    expect(fit('pixels', 200, 100).columns).toBe(96)

    const words = new Uint32Array(Uint8Array.fromBase64(toCells(shades, { columns: 160, rows: 72 })).buffer)
    expect(words.length).toBe(160 * 72 * 3)
    expect([words[0], words[1], words[2]]).toEqual([0x2580, SHADES[0], SHADES[0]])
    expect(words[8 * 3 + 1]).toBe(SHADES[1])
  })

  test('keys and paths', () => {
    expect(['up', 'z', 'X', 'return', ' ', 'p', 'q'].map(buttonFor)).toEqual(['up', 'a', 'b', 'start', 'select', 'pause', undefined])
    expect(expandPath(' "~/Games/demo.gb" ', HOME)).toBe(GAME)
  })
})

describe('the mod', () => {
  // While the emulator's stream is open, each act waits a moment for the
  // engine to go quiet, so this test needs more than the default 5 seconds.
  test('plays a game: spawns the emulator, draws frames, sends keys', { timeoutMs: 20000 }, async ($, on) => {
    const host = fakeHost(on)
    await $.session.start(start)

    const answer = await $.command.run(command('~/Games/demo.gb'))
    expect(answer.text).toContain('Starting')
    await host.clock.settle()
    expect(host.spawned[0]?.slice(-2)).toEqual([expect.stringMatching(/runner\/pocket\.mjs$/), GAME])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'DEMO' })).toBeDefined()
    const screen = await ui.find({ key: 'screen' })
    expect(screen?.type).toBe('Raster')
    expect(screen?.props.columns).toBe(120)

    // The frame that arrived before the pane drew is painted by blit.
    expect(host.blits.length).toBeGreaterThan(0)

    await ui.key({ key: 'right', in: 'pad' })
    await ui.key({ key: 'z', in: 'pad' })
    await ui.key({ key: 'q', in: 'pad' })
    const keys = host.posts.filter(post => post.path === '/keys').flatMap(post => (post.body as { keys: string[] }).keys)
    expect(keys).toEqual(['right', 'a'])

    await ui.key({ key: 'p', in: 'pad' })
    expect(host.posts.some(post => post.path === '/pause')).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'paused' })).toBeDefined()
    await ui.press({ key: 'pause' })
    expect(host.posts.some(post => post.path === '/resume')).toBe(true)

    // The emulator quits on its own: the pane says so and offers to play again.
    host.release()
    await host.clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: 'The console stopped.' })).toBeDefined()
    expect(await ui.find({ key: 'screen' })).toBeUndefined()
    expect(await ui.find({ key: 'restart' })).toBeDefined()
    await ui.unmount()
  })

  test('pauses when Claude finishes a turn, not a subagent', async ($, on) => {
    const host = fakeHost(on)
    await $.session.start(start)
    await $.command.run(command(GAME))
    await host.clock.settle()

    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'sub', reason: 'answer' })
    expect(host.posts.some(post => post.path === '/pause')).toBe(false)
    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(host.posts.some(post => post.path === '/pause')).toBe(true)
    host.release()
    await host.clock.advance(1000)
  })

  test('uses real pixels in Ghostty, and explains a missing file', async ($, on) => {
    const host = fakeHost(on, { HOME, TERM: 'xterm-ghostty' })
    await $.session.start(start)
    const missing = await $.command.run(command('~/nope.gb'))
    expect(missing.text).toContain('There is no file')
    await $.command.run(command(GAME))
    await host.clock.settle()
    expect(host.posts.some(post => post.path === '/mode' && (post.body as { image: boolean }).image)).toBe(true)
    host.release()
    await host.clock.advance(1000)
  })
})
