import { ConfigError, InputError } from './errors.js'

export const modifiers = ['shift', 'alt', 'ctrl', 'super', 'hyper', 'meta']
export const specialKeys = new Map([
  [9, 'tab'],
  [13, 'enter'],
  [27, 'escape'],
  [32, 'space'],
  [43, 'plus'],
  [127, 'backspace'],
  [57348, 'insert'],
  [57349, 'delete'],
  [57350, 'left'],
  [57351, 'right'],
  [57352, 'up'],
  [57353, 'down'],
  [57354, 'pageup'],
  [57355, 'pagedown'],
  [57356, 'home'],
  [57357, 'end'],
  [57358, 'capslock'],
  [57359, 'scrolllock'],
  [57360, 'numlock'],
  [57361, 'printscreen'],
  [57362, 'pause'],
  [57363, 'menu']
])

for (let i = 1; i <= 35; i++) {
  specialKeys.set(57363 + i, `f${i}`)
}

const modifierKeys = ['shift', 'ctrl', 'alt', 'super', 'hyper', 'meta']

for (let i = 0; i < 12; i++) {
  specialKeys.set(57441 + i, `${i < 6 ? 'left' : 'right'}${modifierKeys[i % 6]}`)
}

const names = new Set([...specialKeys.values(), ...modifiers])

export function keyName (code) {
  if (specialKeys.has(code)) {
    return specialKeys.get(code)
  }

  if (code >= 33 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xf8ff)) {
    return String.fromCodePoint(code).toLowerCase()
  }

  return null
}

export function chord (key, mask) {
  return [...modifiers.filter((_, index) => mask & (1 << index)), key].join('+')
}

const joypadButtons = new Set([
  'b',
  'y',
  'select',
  'start',
  'up',
  'down',
  'left',
  'right',
  'a',
  'x',
  'l',
  'r',
  'l2',
  'r2',
  'l3',
  'r3'
])
const commands = new Set(['previousSlot', 'nextSlot', 'togglePause', 'quit'])

export function parseBinding (value) {
  if (typeof value !== 'string') {
    throw new ConfigError('bindings must use action[:modifier] strings; objects and null are not supported')
  }

  const [action, modifier, extra] = value.split(':')

  if (extra !== undefined) {
    throw new ConfigError(`invalid binding ${value}; expected action[:modifier]`)
  }

  // A modifier names a joypad button or save slot, depending on the action.
  if (action === 'joypad') {
    if (!joypadButtons.has(modifier)) {
      throw new ConfigError(`invalid libretro joypad button in binding ${value}`)
    }

    return { action, button: modifier }
  }

  if (['saveState', 'loadState', 'selectSlot'].includes(action)) {
    if (modifier === undefined && action !== 'selectSlot') {
      return { action }
    }

    if (modifier === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(modifier)) {
      throw new ConfigError(`invalid or missing save slot in binding ${value}`)
    }

    return { action, slot: modifier }
  }

  if (!commands.has(action) || modifier !== undefined) {
    throw new ConfigError(`unknown action or unexpected modifier in binding ${value}`)
  }

  return { action }
}

export function formatBinding (binding) {
  if (binding.action === 'joypad') {
    return `joypad:${binding.button}`
  }

  return `${binding.action}${binding.slot === undefined ? '' : `:${binding.slot}`}`
}

export function compileBindings (bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new ConfigError('bindings must be an object mapping keyboard chords to action[:modifier] strings')
  }

  const result = new Map()

  for (const [source, binding] of Object.entries(bindings)) {
    const parts = source.toLowerCase().split('+')
    const key = parts.pop()

    if (
      !key ||
      (!names.has(key) && [...key].length !== 1) ||
      /\s/u.test(key) ||
      key.codePointAt(0) < 32 ||
      key === '\x7f'
    ) {
      throw new ConfigError(`unknown key ${source}; use named keys such as space or plus`)
    }

    // Canonical modifier ordering makes equivalent spellings collide in the same map.
    let mask = 0

    for (const modifier of parts) {
      const index = modifiers.indexOf(modifier)

      if (index < 0 || mask & (1 << index)) {
        throw new ConfigError(`invalid or duplicate modifier in ${source}`)
      }

      mask |= 1 << index
    }

    const canonical = chord(key, mask)

    if (result.has(canonical)) {
      throw new ConfigError(`duplicate keybinding ${source}`)
    }

    result.set(canonical, parseBinding(binding))
  }

  return result
}

const navigation = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', S: 'f4' }
const tilde = {
  2: 'insert',
  3: 'delete',
  5: 'pageup',
  6: 'pagedown',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12'
}
const pasteEnd = Buffer.from('\x1b[201~')

export class KittyInput {
  #buffer = Buffer.alloc(0)
  #bindings
  #callbacks
  #held = new Map()
  #buttons = new Map()
  #mouseButtons = new Set()
  #mousePosition = null
  #focused = true
  #paste = false
  #timer
  #supported = false
  #closed = false
  #stats = { presses: 0, repeats: 0, releases: 0, mouseEvents: 0 }

  constructor (bindings, callbacks) {
    this.#bindings = compileBindings(bindings)
    this.#callbacks = callbacks
  }

  start (timeout) {
    this.#timer = setTimeout(() => {
      if (!this.#supported) {
        this.#callbacks.onError(new InputError('terminal did not acknowledge the Kitty keyboard protocol'))
      }
    }, timeout)
    this.#timer.unref()
  }

  feed (data) {
    if (this.#closed) {
      return
    }

    // Keep a single incremental stream parser: CSI key events and native terminal
    // replies can share a chunk, and any escape sequence can span several chunks.
    this.#buffer = Buffer.concat([this.#buffer, data])

    while (this.#buffer.length) {
      if (this.#paste) {
        const end = this.#buffer.indexOf(pasteEnd)

        if (end < 0) {
          this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - pasteEnd.length + 1))
          return
        }

        this.#buffer = this.#buffer.subarray(end + pasteEnd.length)
        this.#paste = false
        continue
      }

      if (this.#buffer[0] !== 27) {
        // CLI input modes must also recognize cancellation before Kitty negotiation.
        if ([3, 4].includes(this.#buffer[0]) && this.#callbacks.onInterrupt) {
          this.#callbacks.onInterrupt()
          this.#buffer = this.#buffer.subarray(1)
          continue
        }

        // Before negotiation, retain only the configured emergency quit chord.
        // Unencoded text is never converted to held game buttons.
        if (this.#buffer[0] === 3 && this.#bindings.get('ctrl+c')?.action === 'quit') {
          this.#callbacks.onAction(this.#bindings.get('ctrl+c'), true)
        }

        this.#buffer = this.#buffer.subarray(1)
        continue
      }

      if (this.#buffer.length < 2) {
        return
      }

      let end = -1
      const type = this.#buffer[1]

      if (type === 91) {
        end = this.#buffer.findIndex((byte, index) => index >= 2 && byte >= 0x40 && byte <= 0x7e)
        const restart = this.#buffer.indexOf(27, 2)

        if (restart >= 0 && (end < 0 || restart < end)) {
          this.#buffer = this.#buffer.subarray(restart)
          continue
        }
      } else if ([93, 80, 95].includes(type)) {
        const st = this.#buffer.indexOf('\x1b\\', 2)
        const bell = type === 93 ? this.#buffer.indexOf(7, 2) : -1
        end = st < 0 ? bell : bell >= 0 && bell < st ? bell : st + 1
      } else {
        this.#buffer = this.#buffer.subarray(1)
        continue
      }

      if ((end < 0 ? this.#buffer.length : end + 1) > 65536) {
        this.#buffer = Buffer.alloc(0)
        this.releaseAll()
        throw new InputError('terminal escape sequence exceeds 64 KiB')
      }

      if (end < 0) {
        return
      }

      const sequence = this.#buffer.subarray(0, end + 1)
      this.#buffer = this.#buffer.subarray(end + 1)

      if (type !== 91 || !this.#csi(sequence.toString('utf8'))) {
        this.#callbacks.onResponse(sequence)
      }
    }
  }

  #csi (sequence) {
    const body = sequence.slice(2, -1)
    const final = sequence.at(-1)

    if (final === 'u' && /^\?\d+$/.test(body)) {
      this.#supported = true
      clearTimeout(this.#timer)
      return false
    }

    if (sequence === '\x1b[200~') {
      this.#paste = true
      return true
    }

    if (sequence === '\x1b[I' || sequence === '\x1b[O') {
      this.#focused = final === 'I'

      if (!this.#focused) {
        this.releaseAll()
      }

      this.#callbacks.onFocus(this.#focused)
      return true
    }

    // SGR mouse reports: CSI < code ; x ; y followed by M (press, motion, wheel) or m (release).
    if (body[0] === '<' && (final === 'M' || final === 'm')) {
      const fields = body.slice(1).split(';').map(Number)

      if (fields.length === 3 && fields.every(value => Number.isInteger(value) && value >= 0)) {
        this.#mouse(fields[0], fields[1], fields[2], final === 'M')
      }

      return true
    }

    if (!/^[0-9:;]*$/.test(body)) {
      return false
    }

    // Kitty reports modifier/event fields separately from base and shifted key identities.
    const fields = body.split(';')
    const codes = fields[0].split(':').map(value => (value === '' ? null : Number(value)))
    const [encodedMask = '1', event = '1'] = (fields[1] || '1').split(':')
    const mask = Number(encodedMask || 1) - 1
    const eventType = Number(event)
    let key
    let base
    let shifted

    if (final === 'u') {
      key = keyName(codes[0])
      base = keyName(codes[2])
      shifted = keyName(codes[1])
    } else if (final === '~') {
      key = tilde[codes[0]]
    } else if (codes.length === 1 && (codes[0] === null || codes[0] === 1)) {
      key = navigation[final]
    }

    if (!key) {
      return false
    }

    if (!Number.isInteger(mask) || mask < 0 || mask > 255 || ![1, 2, 3].includes(eventType)) {
      return true
    }

    this.#event(key, base, shifted, mask & 63, eventType)
    return true
  }

  #event (key, base, shifted, mask, type) {
    if (!this.#supported || !this.#focused) {
      return
    }

    // Release the action selected at press time, even if the modifier state changed.
    if (type === 3) {
      this.#stats.releases++
      const binding = this.#held.get(key)
      this.#held.delete(key)

      if (binding?.action === 'joypad') {
        const remaining = this.#buttons.get(binding.button) - 1
        this.#buttons.set(binding.button, remaining)

        if (remaining === 0) {
          this.#callbacks.onAction(binding, false)
        }
      }

      return
    }

    if (type === 2 || this.#held.has(key)) {
      this.#stats.repeats++
      return
    }

    this.#stats.presses++

    // A modifier key's own bit is not part of the chord used to bind that key.
    const modifier = /^(?:left|right)(shift|alt|ctrl|super|hyper|meta)$/.exec(key)?.[1]

    if (modifier) {
      mask &= ~(1 << modifiers.indexOf(modifier))
    }

    let binding

    // Prefer exact key identities before alternate layout and generic modifier names.
    const candidates = [
      [key, mask],
      [shifted, mask & ~1],
      [base, mask],
      [modifier, mask]
    ]

    for (const [candidate, candidateMask] of candidates) {
      if (!candidate) {
        continue
      }

      const name = chord(candidate, candidateMask)

      if (this.#bindings.has(name)) {
        binding = this.#bindings.get(name)
        break
      }
    }

    // Allow a plain game button while another modifier-mapped game button is
    // held, but never fall back to an unmodified save/load/quit command.
    if (binding === undefined && this.#bindings.get(key)?.action === 'joypad') {
      binding = this.#bindings.get(key)
    }

    // Remember the press-time action, independent of modifiers on key release.
    this.#held.set(key, binding)

    // Diagnostics and binding capture also need presses without an assigned action.
    this.#callbacks.onKey?.(chord(key, mask), binding)

    if (!binding) {
      return
    }

    // Multiple keys for one button share a held count, so only the first press is dispatched.
    if (binding.action === 'joypad') {
      const count = this.#buttons.get(binding.button) ?? 0
      this.#buttons.set(binding.button, count + 1)

      if (count > 0) {
        return
      }
    }

    this.#callbacks.onAction(binding, true)
  }

  #mouse (code, x, y, press) {
    if (!this.#focused) {
      return
    }

    this.#stats.mouseEvents++
    this.#mousePosition = { x, y }
    const event = { x, y, button: null, pressed: false, wheel: 0 }
    const low = code & 3

    if (code & 64) {
      // Codes 64 and 65 are vertical wheel steps; horizontal steps are not forwarded.
      if (low < 2) {
        event.wheel = low === 0 ? 1 : -1
      }
    } else if (!(code & 32) && low !== 3) {
      // Buttons 0-2 are left, middle and right; bit 128 selects the extra buttons 4 and 5.
      if (code & 128 && low > 1) {
        return
      }

      event.button = code & 128 ? 3 + low : low
      event.pressed = press

      if (press) {
        this.#mouseButtons.add(event.button)
      } else {
        this.#mouseButtons.delete(event.button)
      }
    }

    this.#callbacks.onMouse?.(event)
  }

  releaseAll () {
    for (const [button, count] of this.#buttons) {
      if (count > 0) {
        this.#callbacks.onAction({ action: 'joypad', button }, false)
      }
    }

    this.#buttons.clear()
    this.#held.clear()

    // The terminal reports no releases after focus loss, so release held mouse buttons here.
    for (const button of this.#mouseButtons) {
      this.#callbacks.onMouse?.({ ...(this.#mousePosition ?? { x: null, y: null }), button, pressed: false, wheel: 0 })
    }

    this.#mouseButtons.clear()
  }

  summary () {
    return {
      protocol: 'kitty',
      supported: this.#supported,
      focused: this.#focused,
      heldKeys: this.#held.size,
      ...this.#stats
    }
  }

  close () {
    if (this.#closed) {
      return
    }

    this.releaseAll()
    this.#closed = true
    clearTimeout(this.#timer)
    this.#buffer = Buffer.alloc(0)
  }
}
