// The keyboard pad: a one-line Client under the screen. Once it has the
// focus (a click on it), each key is sent to the hooks module, which passes
// it to the emulator. Esc gives the keyboard back to Claude Code.
//
// A post replaces one not yet delivered in the same frame, so every post
// carries the last few presses, numbered; the hooks module takes the new ones.

import type { ClientModule } from 'claude-code'

import { buttonFor } from './screen'

type Press = { seq: number; button: string }
type PadState = { seq: number; recent: Press[] }
type PadProps = { isPaused: boolean }

const Pad: ClientModule<PadProps, PadState> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onKey(event => {
      const button = buttonFor(event.key)
      if (button === undefined) return
      const current = surface.state ?? { seq: 0, recent: [] }
      const seq = current.seq + 1
      const recent = [...current.recent, { seq, button }].slice(-8)
      surface.setState({ seq, recent })
      surface.post({ recent })
    })
    surface.setState({ seq: 0, recent: [] })
  }
  const { Box, Text } = surface.elements
  return (
    <Box gap={1}>
      <Text bold color={props.isPaused ? 'warning' : 'success'}>
        {props.isPaused ? '❚❚ Paused' : '▶ Click here to play'}
      </Text>
      <Text dimColor wrap="truncate-end">
        ←↑→↓ move · Z = A · X = B · Enter = Start · Space = Select · P = pause · Esc = back to Claude
      </Text>
    </Box>
  )
}

export default Pad
