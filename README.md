# pocket — a handheld game console inside Claude Code

A Claude Code mod that runs a small Game Boy (DMG) emulator in a pane, so you can
play while Claude works. When Claude finishes a turn, the game pauses for you.

```
/pocket ~/Games/my-game.gb
```

**No games are included.** Pocket plays only the game file you give it — use a
backup you made from a cartridge you own. This repository does not include,
download or link to any game files.

## Install

In Claude Code:

```
/plugin marketplace add romanlucian/claude-pocket
/plugin install pocket@pocket
```

Pocket needs **Node.js** (the emulator runs in its own Node process). If Claude
Code can't find `node`, set its full path in the mod's settings (`Node command`;
run `which node` in a terminal to see it).

## Play

1. `/pocket ~/path/to/your-game.gb` — opens the Pocket pane and starts the game.
2. Click the pad line (`▶ Click here to play`) under the screen so it has the keyboard.
3. Play. **Esc** gives the keyboard back to Claude.

| Key | Button |
| --- | --- |
| ← ↑ → ↓ | D-pad |
| Z | A |
| X | B |
| Enter | Start |
| Space | Select |
| P | Pause / resume |

The pane also has buttons: Pause/Resume, Restart, Stop, and
*Pause when Claude finishes* (on by default). `/pocket` with no file reopens the
last game; `/pocket stop` stops it.

## Which terminal

- **Ghostty or kitty:** the screen is drawn with real pixels (sharp).
- **VS Code's terminal and others:** the screen is drawn with half-block
  characters, one game pixel per half character. The game is 160×144 pixels,
  and its letters are only readable at full size: the pane must be about
  **190 columns × 73 rows** (the buttons then sit beside the screen). Smaller
  panes get half size, where the letters break up.

  In VS Code, maximize the terminal panel and make its font small, in
  Settings (JSON):

  ```json
  "terminal.integrated.fontSize": 10,
  "terminal.integrated.lineHeight": 1
  ```

  Then press **Fit** in the pane. The warning under the buttons shows the
  pane's size now and the size it needs.

## What works, what doesn't

- Game Boy (DMG) games with no mapper, MBC1, MBC3 or MBC5 cartridges.
- Passes the blargg `cpu_instrs` and `instr_timing` tests and matches the
  `dmg-acid2` reference picture.
- **No sound.**
- **No save files** yet (battery saves are lost when you stop).
- Terminals only report key presses, not releases, so a key is held for a short
  moment after each press (holding a key repeats it). Fine for most games;
  precise jumps take some getting used to.
- Game Boy Color games are not supported.

## How it works

- `core/` — the emulator: CPU (`cpu.mjs`) and the rest of the machine:
  cartridge, timer, picture, joypad (`machine.mjs`). Plain JavaScript, no
  dependencies.
- `runner/pocket.mjs` — runs the emulator in real time (~60 fps) in a Node
  process, streams frames on stdout and takes keys over a local socket.
- `hooks/` — the mod: the `/pocket` command, the pane, the key pad, and the
  auto-pause when Claude finishes a turn.

Run the tests with `claude plugin test`.

## License

MIT © 2026 Lucian Roman. Game Boy is a trademark of Nintendo; this project is not
affiliated with or endorsed by Nintendo.
