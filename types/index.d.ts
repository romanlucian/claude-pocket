/** The game being played, as the pane shows it. */
export type PocketGame = {
  status: 'idle' | 'starting' | 'running' | 'paused' | 'error'
  title: string
  romPath: string
  message: string
  /** The picture file the terminal reads (pixels mode), once the first frame exists. */
  firstFile: string
  /** The sharp screen's address (a page on 127.0.0.1), once the console is up. */
  webUrl: string
}

declare module 'claude-code' {
  interface PluginState {
    pocket: {
      game: PocketGame
      /** `pixels`: a real picture (Ghostty, kitty). `cells`: colored blocks, any terminal. */
      mode: 'pixels' | 'cells'
      /** Pause the game when Claude finishes a turn. */
      pauseWhenDone: boolean
    }
  }
}
