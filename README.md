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

- **Ghostty or kitty:** the game is drawn with real pixels right in the pane,
  and the title line says *sharp pixels*. The **Picture** button switches
  between sharp pixels and cells; the choice is kept.
- **VS Code's terminal and others:** a terminal like this can only draw
  blocks of text, so Pocket also opens the **sharp screen**: the game in a
  browser window, drawn with crisp pixels at any size. To keep it inside VS
  Code, press **Copy link** in the pane, then run **Simple Browser: Show**
  (Cmd/Ctrl+Shift+P) and paste it. **Open sharp screen** opens it again.

The sharp screen is a page on your own computer only (127.0.0.1, with a
secret address). Its keys are the same, except Select is **Shift**; a browser
knows when you let go of a key, so the controls there feel exactly right.

## What works, what doesn't

- Game Boy (DMG) games with no mapper, MBC1, MBC3 or MBC5 cartridges.
- Passes the blargg `cpu_instrs` and `instr_timing` tests and matches the
  `dmg-acid2` reference picture.
- **No sound.**
- **No save files** yet (battery saves are lost when you stop).
- In the terminal pane, keys are presses only (a terminal reports no
  releases), so a key is held for a short moment after each press. The sharp
  screen has real key releases.
- Game Boy Color games are not supported.

## How it works

- `core/` — the emulator: CPU (`cpu.mjs`) and the rest of the machine:
  cartridge, timer, picture, joypad (`machine.mjs`). Plain JavaScript, no
  dependencies.
- `runner/pocket.mjs` — runs the emulator in real time (~60 fps) in a Node
  process, streams frames on stdout and takes keys over a local socket.
- `runner/web.mjs` — the sharp screen: a page on 127.0.0.1 drawing frames on
  a canvas.
- `hooks/` — the mod: the `/pocket` command, the pane, the key pad, and the
  auto-pause when Claude finishes a turn.

Run the tests with `claude plugin test`.

## License

MIT © 2026 Lucian Roman. Game Boy is a trademark of Nintendo; this project is not
affiliated with or endorsed by Nintendo.
