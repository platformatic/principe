# Principe agent guide

## Documentation and scope

- Keep `README.md` focused on end users: startup, CLI switches, configuration,
  keyboard controls, save locations, compatibility and troubleshooting.
- Keep source layout, implementation contracts and development details here.
- Do not name specific ROMs in the README or add executable build, packaging,
  signing or release instructions there. Use generic content paths in examples.
- Runtime code has no npm dependencies. Keep CLI feature code under `src/cli`.
- This repository does not use tests. Do not add test files, test suites or test
  infrastructure; use lint and targeted ad hoc checks for verification.

## Source layout

```text
src/index.js          # CLI parsing, dispatch and error presentation
src/cli/audio.js      # Human-readable audio device listing
src/cli/bootstrap.js  # On-demand core download and configuration creation/replacement
src/cli/input.js      # Keyboard probe, capture and configuration persistence
src/core.js           # Libretro ABI/environment, session, scheduling and persistence
src/input.js          # Incremental terminal parser, binding grammar and chord handling
src/audio.js          # SDL3 playback and synchronization
src/video.js          # OpenTUI rendering, conversion/scaling and indexing fix
src/video-output.js   # Native output feed
src/config.js         # Defaults, bindings, configuration and asset paths
src/config.schema.json # Editor completion schema; not runtime validation
src/errors.js         # Native Error subclasses with PRINCIPE_* codes
src/scripts/          # Dependency preparation and development/release tools
src/sea/              # Standalone asset configurations
deps/                 # Generated OpenTUI and SDL3 libraries; no core
dist/                 # Generated executable and bundle outputs
tmp/                  # Generated staging directories
```

## Configuration and CLI contracts

- Use `node:util.parseArgs`; preserve short and long aliases documented in the README.
- Keep structured error codes internally. Suppress the code prefix only when the
  CLI prints usage guidance, not for genuine configuration or runtime errors.
- Defaults and default bindings live in `src/config.js`. Configuration groups are
  merged with defaults, except bindings: an absent map selects defaults, while a
  supplied map replaces them completely. An empty map disables all bindings.
- Bindings are `Record<string, string>` using `action[:modifier]`. Compile them to
  action objects for runtime callbacks; persist strings, never object bindings or nulls.
- Validate action names, joypad identifiers, slot modifiers and duplicate canonical
  chords at runtime. The bindings schema only constrains values to strings and must
  not enumerate platform-dependent keyboard keys.
- `paths.core` is required for gameplay. Never restore an implicit core fallback,
  automatic installation download or bundled core asset.
- Audio listing bypasses configuration entirely. Input modes read bindings only;
  they must not require a core or initialize video/audio playback.
- Bootstrap currently recognizes only `snes9x`. Derive its root from the selected
  config destination, download the host-specific nightly into `cores`, create
  `saves`, capture input, then create or fully replace the config.
- Bootstrap may redownload/replace the core and overwrite the config, but must
  never clear or delete saves. Cancellation preserves the existing config and
  saves; the downloaded core remains. Publish completed files atomically.
- Input capture preserves skipped associations and other configuration fields.
  Write only after all prompts finish and reject detected concurrent config edits.
- Ctrl+C and Ctrl+D abort capture/probe, including before Kitty negotiation.
  Always restore terminal modes, remove listeners and clear timers on exit.

## Native libraries and dependency preparation

- `src/config.js` owns library and asset resolution; explicit configuration paths
  override prepared or embedded OpenTUI/SDL3 defaults.
- The renderer and native output feed share one FFI library handle, including in
  standalone mode.
- OpenTUI 0.5.11 is downloaded from npm and checked against SHA-512 integrity.
  Preparation retains only the library, without manifests or extra files.
- SDL3 comes from the host via `pkg-config`; check its native version API and keep
  a stable library filename. Linked system dependencies remain external.
- Preparation checks prerequisites before downloading and stages components
  separately, with rollback if replacement rename fails. Preserve unrelated paths.
- Dependency and packaging scripts load `.env` from their working directory when
  present. Run only one preparation at a time and stop active sessions first.
- Buffer bounds and save-slot path checks are runtime safeguards, independent of
  the editor-only JSON schema.
- The native profile uses synchronous same-thread callbacks, software video
  (`0RGB1555`, `RGB565`, `XRGB8888`) and stereo PCM. Hardware rendering, async core
  audio, variadic logging and VFS are not advertised. Snes9x is the only verified core.

## Rendering and audio invariants

- Derive physical cell geometry from terminal pixel resolution and grid dimensions;
  preserve core display aspect and reserve the status row. Requery on resize,
  including font changes that retain the same grid size.
- Wait for keyboard negotiation, graphics support and pixel geometry before the
  first emulated frame; do not guess cell aspect ratios.
- Use fresh image handles because OpenTUI keys image contents by handle.
- The `fixIndexing` adapter scans the native output feed and changes only placement
  headers. Payload, compression, text and terminal lifecycle remain OpenTUI-managed.
  Without the adapter, OpenTUI writes directly to stdout.
- PCM is signed 16-bit interleaved stereo. SDL converts rates and device formats.
  Prebuffer, bound queued latency and compensate for clock drift; low queued audio
  takes priority over video presentation. Queue latency excludes OS/hardware buffering.
- Pause and asynchronous persistence suspend playback. Loading a state clears the
  old audio timeline before re-priming.

## Persistence and session API

- Battery saves are keyed by ROM hash, independently of core builds and custom
  save-state modules. Restore before the first frame; flush changed memory every
  10 seconds and once before unloading. Use atomic replacement and avoid rewriting
  unchanged data. Reject wrong-sized memory files instead of truncating them.
- Loading a state can rewind SRAM; the resulting memory becomes the next battery save.
- Emulator states are keyed by core binary hash, ROM hash and slot. Flush files and
  rename atomically. Limit serialized state size to 256 MiB.
- Custom persistence modules export async `save(context, data)` and `load(context)`.
  Load returns an owned Buffer or null. Immutable context contains core identity
  and binary hash, content ROM hash and absolute path, and slot as a string.
- The session API requires an interactive terminal. `run()` is unlimited by default;
  an optional frame count supports bounded, real-time-paced interactive runs.
- `stop()` requests a stop. Await the active run and pending persistence before
  closing. Always await `close()` so the final battery write finishes before unload.
- Reject concurrent saves/loads. Only one native core session may be active per
  JS environment because cores have process-global state.
- `summary()` is available to API callers, but the CLI does not print it.

```js
import { loadSession } from './src/core.js'

const session = await loadSession('/path/to/game.sfc', 'principe.json')
try {
  await session.run({ frames: 120 })
  await session.saveState('checkpoint')
  await session.run({ frames: 60 })
  await session.loadState('checkpoint')
} finally {
  await session.close()
}
```

## Licenses and verification

- Preserve upstream license texts verbatim in `LICENSE` and `THIRD_PARTY_NOTICES`.
  Review applicable snapshots when changing Node, OpenTUI, SDL or their redistributed dependencies.
- Keep notice texts out of the CLI bundle; applicable notices must still accompany
  binary distributions. Snes9x is not a bundled component.
  On-demand download does not remove the core's separate non-commercial license.
- Extensionless `LICENSE` and `THIRD_PARTY_NOTICES` in the repository root are the
  only license notice sources; artifact preparation only copies them beside the
  executable. Keep upstream source URLs with notices and cover embedded dependencies,
  including SDL's HIDAPI, yuv2rgb and fdlibm components. Do not restore duplicate
  notice modules or historical notices for cores that are not redistributed.
- Match notices to the actual Node, SDL and OpenTUI binaries for each release target.
  A custom Node build or a host SDL version change requires a fresh notice review;
  successful packaging alone does not establish license compliance.
- Do not claim universal libretro compatibility or unverified native gameplay
  support. The verified execution target is macOS arm64.
- Load `.env` when present before executing project scripts. Formatting changes
  should stay focused; avoid reformatting unrelated user changes.

```sh
pnpm run format
pnpm run lint
```
