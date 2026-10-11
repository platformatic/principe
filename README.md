# Principe

A Node.js terminal frontend for external libretro cores: the core, OpenTUI and SDL3 are loaded directly through
`node:ffi`. JavaScript handles configuration, input, pixel conversion, scheduling
and asynchronous save states. Cores and ROMs remain external to the project.
Snes9x is the only core verified so far; implementing libretro does not guarantee
compatibility with every core. No core is bundled or downloaded during installation;
bootstrap can download a recognized core on explicit request.

## Getting Started

- Node.js 26.10.0 or newer in the 26.x line when running from source.
- pnpm 11 (the package pins 11.0.8).
- An interactive terminal supporting Kitty keyboard and graphics, such as Ghostty.
- SDL 3.2+ and `pkg-config` for dependency preparation (`brew install pkg-config sdl3` on macOS).
- A trusted external libretro core matching the host OS and architecture, and compatible uncompressed content.
- Network access and `unzip` when using bootstrap to download a core.

The verified execution target is macOS arm64. Linux and macOS x64 have dependency
and core-download support, but still require native gameplay verification.

```sh
pnpm install
# Download the core and create or replace the selected configuration.
pnpm start -b snes9x -c play/principe.json
pnpm start "/path/to/game.sfc" -c play/principe.json
```

With the standalone executable, no Node.js installation is required:

```sh
principe -b                   # List recognized core IDs; currently only snes9x
principe -b snes9x            # Download the core, configure keys, then save principe.json
principe "/path/to/game.sfc"
```

Bootstrap accepts zero or one positional core ID and respects `-c`/`--config`.
The config destination's parent directory is `$ROOT`, regardless of the current
working directory. With a core ID, bootstrap downloads the matching host binary to
`$ROOT/cores/snes9x_libretro.dylib` on macOS or `.so` on Linux, creates `$ROOT/saves`,
runs interactive keyboard setup, and writes the config only after setup completes.
Core and save paths are stored relative to the configuration directory.
The config directory is created if necessary. Bootstrap always downloads the core
again, atomically replaces the existing core, and completely replaces an existing
config after keyboard setup. It creates `saves` if necessary but never empties or
deletes it or its contents. Stop running gameplay sessions before replacing a core.
Listing recognized IDs needs no config, network,
terminal or filesystem writes.

Ctrl+C or Ctrl+D during keyboard setup cancels without creating or replacing the
config. The downloaded core remains and existing saves are preserved. Bootstrap
can be rerun in the same directory. The download uses the Libretro
buildbot's unpinned `latest` nightly, as the previous dependency preparation did.
Snes9x retains its non-commercial license. Bootstrap never downloads ROMs, and does
not download OpenTUI or SDL: these remain prepared or embedded dependencies.

**Both an external core and a ROM are required.** Set `paths.core` in the configuration
to the core library (`.dylib` on macOS, `.so` on Linux). The path in the supplied
`principe.json` is a placeholder, not a provided library. To select a configuration file:

```sh
pnpm start "/path/to/game.sfc" -c principe.json
node src/index.js --config principe.json "/path/to/game.sfc"
```

### CLI switches

Available options:

| Short | Long | Argument | Behavior |
| ----- | ---- | -------- | -------- |
| `-h` | `--help` | None | Print usage and exit without loading configuration. |
| `-c` | `--config` | JSON path | Select the config for gameplay or input; select the destination for bootstrap. Ignored by audio listing. |
| `-a` | `--audio` | None | List audio playback devices without a ROM, core or configuration. |
| `-i` | `--input` | None | Capture keyboard bindings and update an existing config. No ROM or core required. |
| `-p` | `--probe` | None | With input mode, display recognized shortcuts and assigned actions without writing the config. |
| `-b` | `--bootstrap` | Optional positional core ID | Without an ID, list recognized cores. With an ID, download the core and create or replace a config after keyboard setup. |

Audio, input and bootstrap modes are mutually exclusive. Probe requires input
mode. Boolean aliases can be combined: `-ip` is equivalent to `--input --probe`.
Gameplay accepts exactly one positional ROM; bootstrap accepts at most one
positional core ID. For example:

```sh
principe -h
principe -a
principe -i -c play/principe.json
principe -ip -c play/principe.json
principe -b snes9x -c play/principe.json
principe --config play/principe.json "/path/to/game.sfc"
```

Use `--` before a ROM filename starting with `-`.
Without `--config`, `principe.json` in the working directory is loaded if present;
otherwise defaults are used, but startup fails unless an external core is configured.
An explicit `--config` takes precedence.
An explicitly requested missing or invalid config is an error in gameplay and input
modes; bootstrap instead creates or completely replaces the selected destination.

The ROM path is relative to the working directory. Paths inside a configuration
are relative to that JSON file; without a file, default data directories are
relative to the working directory. Default native libraries are resolved from
the project or the standalone executable.

Execution always uses OpenTUI and real-time pacing, until SIGINT, SIGTERM or a
core shutdown request. The CLI restores the terminal on exit and does not print
a JSON summary. The native core can print its own startup messages. Save states
remain explicit; cartridge battery memory is restored and saved automatically.

## Dependencies

`pnpm install` runs `prepare`; `pnpm run prepare` (also available as
`pnpm run dependencies`) rebuilds the host's generated dependency directories:

```text
deps/video/    # Only the OpenTUI 0.5.11 dylib/so
deps/audio/    # Only the local SDL3 dylib/so
```

Core libraries are supplied through `paths.core`, either manually or by bootstrap;
dependency preparation never downloads them.
OpenTUI 0.5.11 is downloaded from npm. SDL is imported from the host using
`pkg-config` and checked for version compatibility.
Its version depends on the local installation and is checked during preparation.
Linked system libraries must still be available on the destination machine.

Preparation checks local prerequisites before downloading components.
Run only one preparation at a time and
stop running sessions before refreshing native libraries. No ROM is downloaded.

## Licenses

`LICENSE` contains Principe's license. `THIRD_PARTY_NOTICES` contains license texts
and copyright notices for redistributed components, including Node's third-party
notices. Both files are available in the repository and accompany the executable
in release archives. Keep them with the executable when redistributing it.
Notices are not embedded in the executable; there is no license-display CLI command.

External cores retain their own licenses; users must comply with the license of
the core they obtain, including a core downloaded through bootstrap. Snes9x is not
included in project release artifacts and is not covered by their bundled notices.

## Configuration

`src/config.schema.json` provides editor completion only; it is not loaded or
validated at runtime. An optional JSON configuration is merged with defaults for
paths and options. All fields are optional except `paths.core`; unknown fields are
not rejected. The defaults are:

```json
{
  "$schema": "./src/config.schema.json",
  "version": 1,
  "paths": {
    "system": "./data/system",
    "core": null,
    "video": null,
    "audio": null,
    "saves": "saves"
  },
  "options": {
    "core": {},
    "video": {
      "maxFps": 60,
      "scaling": 3,
      "zlib": true,
      "aspectRatio": null,
      "fixIndexing": true
    },
    "ui": { "showStatus": true, "protocolTimeoutMs": 2000 },
    "audio": {
      "enabled": true,
      "device": null,
      "volume": 1,
      "latencyMs": 80,
      "maxLatencyMs": 200,
      "maxRateCorrection": 0.005
    },
    "save": { "initialSlot": 1, "module": null }
  },
  "bindings": {
    "w": "joypad:up",
    "a": "joypad:left",
    "s": "joypad:down",
    "d": "joypad:right",
    "j": "joypad:x",
    "i": "joypad:y",
    "k": "joypad:b",
    "l": "joypad:a",
    "u": "joypad:l",
    "o": "joypad:r",
    "space": "joypad:start",
    "enter": "joypad:select",
    "q": "loadState",
    "e": "saveState",
    "z": "previousSlot",
    "x": "nextSlot"
  }
}
```

The default `paths.core: null` is deliberately unusable: configure an external
core path before starting a session. Omitting `bindings` selects the built-in
bindings; a supplied map replaces them completely, and `bindings: {}` disables all bindings.

### Paths

| Field          | Meaning                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| `paths.system` | Core system-file directory.                                                |
| `paths.saves`  | Save-state directory; also supplied to the core as its save directory.     |
| `paths.core`   | Required external libretro library; no prepared or embedded core fallback. |
| `paths.video`  | Optional OpenTUI 0.5.11 library; `null` selects the prepared or embedded library. |
| `paths.audio`  | Optional SDL3 library; `null` selects the prepared or embedded library. |

### Core and video

`options.core` is a map of core-specific option names to **string** values.
Unsupported option names/values are rejected during core initialization.

| Video option  | Meaning                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `maxFps`      | Presentation limit, 1–240, default 60. Does not change the core's nominal FPS.                                            |
| `scaling`     | Maximum integer source pre-scaling, 1–8, default 3. Uses nearest-neighbor.                                                |
| `zlib`        | Native OpenTUI upload compression, default true; false selects raw transport.                                             |
| `aspectRatio` | Display width/height override, 0.1–10; null uses the core's display aspect.                                               |
| `fixIndexing` | Correct image layering for Kitty graphics, default true. See below for details. |

Changing source scaling does not shrink the displayed viewport. The terminal may
still interpolate the uploaded image to fill its placement. Larger source scales
improve sharpness but cost more CPU, memory and transfer bandwidth.

`options.video.fixIndexing` controls how game images are layered relative to the
terminal's cell backgrounds and text. When enabled, it rewrites the Kitty image
placement z-index to `-1`: game images appear above cell backgrounds but below
text. This avoids images being hidden behind cell backgrounds in terminals such
as cmux, while keeping text overlays visible.

The option changes only image layering, not game pixels, scaling, colors or
compression. It is enabled by default; set it to `false` to leave OpenTUI's
original image layering unchanged, for example when troubleshooting rendering
differences in your terminal. It does not add Kitty graphics support to terminals
that lack it.

The display preserves the core's aspect ratio and adapts to terminal resize or
font changes. A terminal that does not respond to graphics or pixel-size queries
raises `PRINCIPE_VIDEO`; missing keyboard support raises `PRINCIPE_INPUT`.

### UI

- `options.ui.showStatus`: default true. Slot/session status on the left, current
  core frame resolution and SDL device on the right.
- `options.ui.protocolTimeoutMs`: 100–10000 ms, default 2000. Applies to Kitty
  keyboard negotiation and terminal pixel-resolution queries.

### Audio

- `enabled`: default true. False omits SDL playback.
- `device`: exact device name, or null for the system default output.
- `volume`: 0–1, default 1.
- `latencyMs`: target prebuffer/queued PCM duration, 20–500 ms, default 80.
- `maxLatencyMs`: hard queue bound, 40–2000 ms, default 200. Must exceed
  `latencyMs + 20`; the device's actual buffer size can require more margin.
- `maxRateCorrection`: maximum fractional drift correction, 0–0.02, default
  0.005 (0.5%). Zero disables correction.

```sh
principe --audio
# Short alias: principe -a
# In source mode:
pnpm start --audio
```

The command lists playback device names in a human-readable format using the prepared
or embedded SDL3 library. It does not load configuration, including an explicit
`--config`, and does not require a core, ROM or interactive terminal.
Use the returned device **name**, not its temporary SDL ID. Configured queue latency
excludes OS/hardware buffering. Audio pauses with gameplay and while saving/loading
states; loading a state resets playback to the restored timeline.

### Save options

- `options.save.initialSlot`: positive integer or a 1–64-character name containing
  ASCII letters, digits, `_` and `-`; default 1. Selecting it does not load it.
- `options.save.module`: optional ESM module path relative to the JSON; null uses
  atomic disk storage.

## Default controls

### Interactive input configuration

```sh
principe --input --probe
# Short aliases can be combined: principe -ip
principe --input -c principe.json
# In source mode:
pnpm start --input --probe
pnpm start --input -c principe.json
```

Both modes require a Kitty-keyboard-compatible interactive terminal, but no core,
ROM, video renderer or audio initialization. They read only bindings from the selected
configuration (`principe.json` by default). Probe can use defaults if the implicit
configuration is absent; an explicit missing or malformed configuration is an error.
Probe prints recognized chords and corresponding actions without modifying anything;
Ctrl+C or Ctrl+D exits probe mode.

Capture requires an existing JSON configuration. Game controls are grouped in this
order: directions (up, down, left, right), main buttons (A, B, X, Y), menu buttons
(Start, Select), shoulders/triggers (L, R, L2, R2), and stick presses (L3, R3).
Principe commands follow: pause/resume, save state, load state, previous slot,
next slot, and quit. Each group has its own heading. Each prompt
shows the current associations and a five-second countdown. Press a key or chord to
replace the action's associations, or wait to retain them (including an unassigned
action). Keys assigned to a different action are rejected instead of silently moved.
Modifier keys alone are not captured, so combinations such as Ctrl+Q work.
Ctrl+C and Ctrl+D are reserved for cancellation, including before Kitty negotiation;
neither can be assigned by the wizard. SIGINT/SIGTERM also cancels without saving.

Only the bindings are updated, after all prompts finish; other JSON fields are
preserved. The wizard writes a complete string map, retaining skipped associations
and omitting disabled or replaced keys instead of writing null entries.
The file is replaced atomically, and changes detected during capture
cause saving to fail rather than overwrite those edits.

| Keys      | Action                     |
| --------- | -------------------------- |
| W         | Up                         |
| A         | Left                       |
| S         | Down                       |
| D         | Right                      |
| Space     | Start                      |
| Enter     | Select                     |
| J         | X                          |
| I         | Y                          |
| K         | B                          |
| L         | A                          |
| U         | L shoulder                 |
| O         | R shoulder                 |
| Q / E     | Load/save current slot     |
| Z / X     | Previous/next numeric slot |

`principe.json` can contain additional custom associations.
No other shortcuts are enabled by default; configure `quit` or `togglePause` if needed.
Joypad names are standard libretro identifiers, not keyboard keys or Snes9x-specific
controls. Their meaning depends on the core. The schema does not enumerate keyboard keys.
Press/repeat/release events are tracked incrementally; keys mapped to the same
button are aggregated, and focus loss releases held buttons.

Configure top-level `bindings` as a complete map of keyboard chords to
`action[:modifier]` strings. Omit a key to leave it unassigned. There is no merge
with defaults and no null entries:

```json
{
  "bindings": {
    "ctrl+1": "loadState:checkpoint",
    "ctrl+shift+1": "saveState:checkpoint",
    "f2": "selectSlot:checkpoint",
    "backspace": "joypad:select",
    "ctrl+c": "quit"
  }
}
```

| Binding | Meaning |
| ------- | ------- |
| `joypad:<button>` | Required standard libretro digital joypad identifier. |
| `saveState[:slot]` / `loadState[:slot]` | Save/load a specified slot, or the current slot when omitted. |
| `selectSlot:<slot>` | Select a required slot. |
| `previousSlot` / `nextSlot` | Change the current numeric slot. |
| `togglePause` / `quit` | Pause/resume or exit. No modifier allowed. |

Joypad identifiers are `b`, `y`, `select`, `start`, `up`, `down`, `left`, `right`,
`a`, `x`, `l`, `r`, `l2`, `r2`, `l3`, and `r3`. Slot modifiers contain 1–64 ASCII
letters, digits, `_` or `-`. Chords are case-insensitive; action and modifier names
are case-sensitive. Equivalent duplicate chords, unknown actions, invalid modifiers,
legacy object bindings and null values raise `PRINCIPE_CONFIG`.
The bindings schema only requires string values; semantic validation happens at runtime.

## Saves

### Cartridge battery memory (automatic)

Games' own save menus are persisted through libretro `SAVE_RAM` (SRAM), and `RTC`
memory when supplied by the core. Files live at:

```text
<paths.saves>/battery/<rom-sha256>/save.srm
<paths.saves>/battery/<rom-sha256>/clock.rtc
```

Battery memory is restored after loading the ROM, before the first emulated
frame. During play, changed data is flushed every 10 seconds and once more before
the core is unloaded. Writes use atomic replacement; unchanged data is not
rewritten. Cartridges without battery memory create no battery files.

The namespace follows the ROM, not the core binary, so updating the core retains
cartridge saves. A wrong-sized file raises `PRINCIPE_PERSISTENCE` at startup
instead of being truncated or overwritten. Battery storage is local to
`paths.saves`, independently of the custom save-state module. Loading an emulator
state can also rewind SRAM; its resulting contents become the next battery save.

### Emulator save states (explicit)

Disk storage writes serialized core state to:

```text
<paths.saves>/<core-binary-sha256>/<rom-sha256>/<slot>.state
```

Files are flushed and atomically renamed. Core builds and ROMs have separate
namespaces. These are emulator states. Previous/next slots preserve the last numeric selection when
a named slot is selected. An explicit save/load slot does not change selection.
Numeric `1` and named `"1"` identify the same stored slot.

## Errors

| Code                   | Meaning                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `PRINCIPE_CONFIG`      | Invalid CLI arguments, unreadable/malformed JSON, paths or core options |
| `PRINCIPE_NATIVE`      | Core loading, ABI, frame, timing or serialization failure             |
| `PRINCIPE_VIDEO`       | Missing TTY/pixel resolution, native renderer or presentation failure |
| `PRINCIPE_INPUT`       | Keyboard negotiation timeout or invalid input stream                  |
| `PRINCIPE_AUDIO`       | SDL library, device, format, queue or playback failure                |
| `PRINCIPE_STATE`       | Invalid action/slot, concurrency or session lifecycle                 |
| `PRINCIPE_PERSISTENCE` | State storage or custom module failure                                |
| `PRINCIPE_DEPENDENCY`  | Native dependency download or integrity failure                       |

Implementation details and development guidance are in [AGENTS.md](AGENTS.md).
