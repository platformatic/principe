import { randomUUID } from 'node:crypto'
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defaultBindings, defaultConfig } from '../config.js'
import { ConfigError, InputError } from '../errors.js'
import { compileBindings, formatBinding, KittyInput } from '../input.js'

const groups = [
  { title: 'Game controls — Directions', buttons: ['up', 'down', 'left', 'right'] },
  { title: 'Game controls — Main buttons', buttons: ['a', 'b', 'x', 'y'] },
  { title: 'Game controls — Menu', buttons: ['start', 'select'] },
  { title: 'Game controls — Shoulder buttons and triggers', buttons: ['l', 'r', 'l2', 'r2'] },
  { title: 'Game controls — Stick buttons', buttons: ['l3', 'r3'] },
  { title: 'Principe commands — Session', actions: ['togglePause'] },
  { title: 'Principe commands — Save states', actions: ['saveState', 'loadState', 'previousSlot', 'nextSlot'] },
  { title: 'Principe commands — Exit', actions: ['quit'] }
]
const targets = groups.flatMap(group => {
  const bindings = group.buttons
    ? group.buttons.map(button => ({ action: 'joypad', button }))
    : group.actions.map(action => ({ action }))
  return bindings.map(binding => ({ group: group.title, binding }))
})
const actionLabels = {
  loadState: 'Load state',
  saveState: 'Save state',
  previousSlot: 'Previous save slot',
  nextSlot: 'Next save slot',
  togglePause: 'Pause / resume',
  quit: 'Quit'
}

export function bindingLabel (binding) {
  if (!binding) {
    return 'Not assigned'
  }

  if (binding.action === 'joypad') {
    return ['up', 'down', 'left', 'right'].includes(binding.button)
      ? `D-pad ${binding.button}`
      : `Joypad ${String(binding.button).toUpperCase()}`
  }

  const action = actionLabels[binding.action] ?? binding.action
  return `${action}${binding.slot === undefined ? '' : ` (slot ${binding.slot})`}`
}

const keyLabels = {
  pageup: 'Page Up',
  pagedown: 'Page Down',
  capslock: 'Caps Lock',
  scrolllock: 'Scroll Lock',
  numlock: 'Num Lock',
  printscreen: 'Print Screen'
}

function keyLabel (key) {
  // Format canonical names for display only; persisted chords stay unchanged.
  return key
    .split('+')
    .map(
      part =>
        keyLabels[part] ??
        part
          .replace(/^(left|right)(shift|alt|ctrl|super|hyper|meta)$/, '$1 $2')
          .replace(/(^|\s)\S/g, character => character.toUpperCase())
    )
    .join(' + ')
}

export async function selectMouse () {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  // Readline treats Ctrl+D after typed text as editing, but setup always reserves it for exit.
  const onData = data => {
    if (data.includes(3) || data.includes(4)) {
      cancel()
    }
  }

  prompt.on('SIGINT', cancel)
  prompt.on('close', cancel)
  process.stdin.prependListener('data', onData)
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)

  try {
    const answer = await prompt.question('Enable mouse support? [y/N] ', { signal: controller.signal })
    return /^(?:y|yes)$/i.test(answer.trim())
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('\nSetup cancelled. No configuration changes were saved.')
      return
    }

    throw new InputError(`cannot read mouse selection: ${error.message}`, { cause: error })
  } finally {
    process.stdin.off('data', onData)
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
    prompt.off('SIGINT', cancel)
    prompt.off('close', cancel)
    prompt.close()
  }
}

export async function configureInput ({ config, probe = false }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new InputError('--input requires an interactive terminal supporting Kitty keyboard')
  }

  // Read the whole file for preservation, but validate only the fields used by this mode.
  let path = resolve(config ?? 'principe.json')
  let original
  let parsed = {}

  try {
    original = await readFile(path, 'utf8')
    parsed = JSON.parse(original)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError('configuration must be a JSON object')
    }

    if (
      parsed.bindings !== undefined &&
      (!parsed.bindings || typeof parsed.bindings !== 'object' || Array.isArray(parsed.bindings))
    ) {
      throw new ConfigError('bindings must be a JSON object')
    }

    path = await realpath(path)
  } catch (error) {
    if (!probe || config !== undefined || error.code !== 'ENOENT') {
      throw error.code === 'PRINCIPE_CONFIG' ? error : new ConfigError(error.message, { cause: error })
    }
  }

  // Read bindings only: this mode must not require a core or resolve other config paths.
  const sourceBindings = parsed.bindings === undefined ? defaultBindings : parsed.bindings
  const savedBindings = await captureInput({ path, bindings: sourceBindings, probe })

  if (savedBindings === undefined) {
    return
  }

  const mouse = await selectMouse()

  if (mouse === undefined) {
    return
  }

  let temporary

  try {
    // Refuse to overwrite edits made while the interactive wizard was running.
    if ((await readFile(path, 'utf8')) !== original) {
      throw new ConfigError('configuration changed during input capture; no changes saved')
    }

    // Stage a complete replacement beside the original, retaining its file permissions.
    const { mode } = await stat(path)
    const candidate = `${path}.${randomUUID()}.tmp`
    const file = await open(candidate, 'wx', mode)
    temporary = candidate

    try {
      const input = { ...defaultConfig.options.input, ...parsed.options?.input, mouse }
      const settings = { ...parsed, options: { ...parsed.options, input }, bindings: savedBindings }
      await file.writeFile(JSON.stringify(settings, null, 2) + '\n')
    } finally {
      await file.close()
    }

    await rename(temporary, path)
    temporary = undefined
    console.log(`\nInput setup complete. Configuration saved to ${path}`)
  } catch (error) {
    throw error.code === 'PRINCIPE_CONFIG' ? error : new ConfigError(error.message, { cause: error })
  } finally {
    if (temporary) {
      await unlink(temporary)
    }
  }
}

export async function captureInput ({ path, bindings: sourceBindings = defaultBindings, probe = false }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new InputError('--input requires an interactive terminal supporting Kitty keyboard')
  }

  // Capture updates a local map; callers decide whether and where to persist it.
  const bindings = Object.fromEntries(compileBindings(sourceBindings))
  const ready = Promise.withResolvers()
  const stopped = Promise.withResolvers()
  let capture
  let failure
  let interrupted = false

  // Wake every pending phase when cancellation or a parser failure stops the session.
  const stop = () => {
    interrupted = true
    ready.resolve()
    capture?.resolve(null)
    stopped.resolve()
  }

  const input = new KittyInput(sourceBindings, {
    onInterrupt: stop,
    onAction: () => {},
    onFocus: () => {},
    onResponse: () => {
      if (input.summary().supported) {
        ready.resolve()
      }
    },
    onError: error => {
      failure = error
      stop()
    },
    onKey: (key, binding) => {
      if (interrupted) {
        return
      }

      if (probe) {
        process.stdout.write(`  ${keyLabel(key).padEnd(24)} ${bindingLabel(binding)}\r\n`)
      } else {
        // Modifier presses precede chords; capture the main key, not Ctrl or Shift alone.
        if (!/^(?:left|right)(?:shift|alt|ctrl|super|hyper|meta)$/.test(key)) {
          capture?.resolve(key)
        }
      }
    }
  })

  const onData = data => {
    try {
      input.feed(data)
    } catch (error) {
      failure = error
      stop()
    }
  }

  const raw = process.stdin.isRaw
  const flowing = process.stdin.readableFlowing

  try {
    // Own stdin only for this command and negotiate before accepting captured keys.
    process.stdin.setRawMode(true)
    process.stdin.on('data', onData)
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    process.stdin.on('end', stop)
    input.start(2000)

    // Request disambiguation, event types, alternate keys and encoding of all keys.
    process.stdout.write('\x1b[>15u\x1b[?u\x1b[?1004h')
    await ready.promise

    if (probe && !interrupted) {
      process.stdout.write('\r\nKeyboard probe\r\n')
      process.stdout.write('Press a key or shortcut to see its assigned action. Ctrl+C or Ctrl+D exits.\r\n\r\n')
      process.stdout.write(`  ${'KEY / SHORTCUT'.padEnd(24)} ACTION\r\n`)

      await stopped.promise
    } else if (!interrupted) {
      process.stdout.write(`\r\nKeyboard setup\r\nConfiguration: ${path}\r\n\r\n`)
      process.stdout.write('Press a key or shortcut for each action. Wait 5 seconds to keep the current binding.\r\n')
      process.stdout.write(
        'Ctrl+C or Ctrl+D cancels without saving. Changes are saved only when setup finishes.\r\n\r\n'
      )

      for (const [index, { group, binding: target }] of targets.entries()) {
        if (interrupted) {
          break
        }

        if (index === 0 || group !== targets[index - 1].group) {
          process.stdout.write(`\r\n${group}\r\n`)
        }

        // Keep the current associations as the timeout default for this action.
        const label = bindingLabel(target)
        const existing = Object.keys(bindings).filter(key => bindingLabel(bindings[key]) === label)
        const current = existing.map(keyLabel).join(' / ') || 'Not assigned'
        const step = `[${index + 1}/${targets.length}] ${label}`
        let accepted = false

        while (!accepted) {
          if (interrupted) {
            break
          }

          // Each retry gets its own countdown and promise, cleared before advancing.
          capture = Promise.withResolvers()
          let seconds = 5
          const prompt = () => process.stdout.write(`\r\x1b[2K${step} — Current: ${current} — Keep in ${seconds}s: `)
          prompt()

          const timer = setInterval(() => {
            seconds--
            if (seconds === 0) {
              capture.resolve(null)
            } else {
              prompt()
            }
          }, 1000)

          let key
          try {
            key = await capture.promise
          } finally {
            clearInterval(timer)
            capture = undefined
          }

          process.stdout.write('\r\n')

          if (interrupted) {
            break
          }

          // Never steal a chord from another action or partially replace its associations.
          if (key && bindings[key] && bindingLabel(bindings[key]) !== label) {
            process.stdout.write(
              `  ${keyLabel(key)} is already used for ${bindingLabel(bindings[key])}. Please choose another key.\r\n`
            )
            continue
          }

          if (key) {
            for (const previous of existing) {
              delete bindings[previous]
            }

            bindings[key] = target
          }

          process.stdout.write(`  ${key ? `Assigned: ${keyLabel(key)}` : `Kept: ${current}`}\r\n`)
          accepted = true
        }
      }
    }
  } finally {
    // Restore the caller's terminal and stdin state even after a partial negotiation.
    input.close()
    process.stdin.off('data', onData)
    process.stdin.off('end', stop)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    process.stdout.write('\x1b[?1004l\x1b[<u')
    process.stdin.setRawMode(raw)

    if (!flowing) {
      process.stdin.pause()
    }
  }

  if (failure) {
    throw failure
  }

  if (probe || interrupted) {
    console.log(probe ? '\nKeyboard probe closed.' : '\nSetup cancelled. No configuration changes were saved.')
    return
  }

  // Return a complete map: omitted chords stay disabled without null tombstones.
  return Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, formatBinding(binding)]))
}
