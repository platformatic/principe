import { dlopen, getRawPointer, toBuffer, toString } from 'node:ffi'
import { endianness } from 'node:os'
import { NativeError, ConfigError, PersistenceError, StateError } from './errors.js'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { loadConfig } from './config.js'
import { OpenTUI } from './video.js'
import { KittyInput } from './input.js'
import { SDLAudio } from './audio.js'

// libretro.h uses LP64 layouts on the supported macOS/Linux 64-bit targets.
// size_t and pointers are 8 bytes; unsigned and enum fields are 4 bytes.
export function openLibrary (path) {
  if (endianness() !== 'LE' || !['arm64', 'x64'].includes(process.arch)) {
    throw new NativeError('only little-endian 64-bit targets are supported')
  }

  const signatures = {
    retro_api_version: { arguments: [], return: 'uint32' },
    retro_get_system_info: { arguments: ['pointer'], return: 'void' },
    retro_get_system_av_info: { arguments: ['pointer'], return: 'void' },
    retro_init: { arguments: [], return: 'void' },
    retro_deinit: { arguments: [], return: 'void' },
    retro_load_game: { arguments: ['pointer'], return: 'bool' },
    retro_unload_game: { arguments: [], return: 'void' },
    retro_run: { arguments: [], return: 'void' },
    retro_get_memory_data: { arguments: ['uint32'], return: 'pointer' },
    retro_get_memory_size: { arguments: ['uint32'], return: 'uint64' },
    retro_set_controller_port_device: { arguments: ['uint32', 'uint32'], return: 'void' },
    retro_serialize_size: { arguments: [], return: 'uint64' },
    retro_serialize: { arguments: ['pointer', 'uint64'], return: 'bool' },
    retro_unserialize: { arguments: ['pointer', 'uint64'], return: 'bool' }
  }

  for (const name of [
    'environment',
    'video_refresh',
    'audio_sample',
    'audio_sample_batch',
    'input_poll',
    'input_state'
  ]) {
    signatures[`retro_set_${name}`] = { arguments: ['pointer'], return: 'void' }
  }

  // SAFETY: Only trusted native cores implementing libretro API v1 may be loaded.
  const handle = dlopen(path)

  try {
    return { lib: handle.lib, functions: handle.lib.getFunctions(signatures) }
  } catch (error) {
    handle.lib.close()
    throw error
  }
}

export function memory (pointer, length) {
  if (
    !pointer ||
    pointer === -1n ||
    pointer === 0xffffffffffffffffn ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 256 * 1024 * 1024
  ) {
    throw new NativeError('invalid native memory range')
  }

  // SAFETY: Callers supply live libretro buffers of the declared ABI size.
  // Borrowed views must be consumed synchronously, before returning to the core.
  return toBuffer(pointer, length, false)
}

export function stringAt (pointer) {
  // SAFETY: These addresses are NUL-terminated strings supplied by the live core.
  return pointer ? toString(pointer) : null
}

export function pointerOf (buffer) {
  // SAFETY: Owners retain buffers until the core is unloaded; never detach them.
  return getRawPointer(buffer)
}

export function readGeometry (buffer) {
  return {
    width: buffer.readUInt32LE(0),
    height: buffer.readUInt32LE(4),
    maxWidth: buffer.readUInt32LE(8),
    maxHeight: buffer.readUInt32LE(12),
    aspectRatio: buffer.readFloatLE(16)
  }
}

export function readAV (buffer) {
  // The double-aligned timing struct starts at offset 24, following geometry.
  return { ...readGeometry(buffer), fps: buffer.readDoubleLE(24), sampleRate: buffer.readDoubleLE(32) }
}

export class Environment {
  pixelFormat = 0
  shutdown = false
  av = null
  messages = []
  logs = []
  unsupported = new Set()
  options = new Map()
  #configured
  #strings = new Map()
  #paths
  #log

  constructor (config, log = null) {
    this.#configured = config.options.core
    this.#log = log

    // These command IDs ask for system files, the loaded core and the save directory.
    this.#paths = new Map([
      [9, config.paths.system],
      [19, config.paths.core],
      [31, config.paths.saves]
    ])
  }

  #string (value) {
    // Keep each NUL-terminated buffer alive while the core may retain its address.
    if (!this.#strings.has(value)) {
      this.#strings.set(value, Buffer.from(`${value}\0`))
    }

    return pointerOf(this.#strings.get(value))
  }

  log (level, format) {
    // Only the fixed arguments reach JavaScript: variadic values are never formatted.
    this.logs.push({ level, format: stringAt(format) })

    if (this.logs.length > 64) {
      this.logs.shift()
    }
  }

  handle (command, pointer) {
    // Preserve extension bits: experimental and private commands must not alias
    // unrelated stable commands. Only explicitly implemented IDs are accepted.
    if (this.#paths.has(command)) {
      memory(pointer, 8).writeBigUInt64LE(this.#string(this.#paths.get(command)))
      return 1
    }

    switch (command) {
      case 3: // GET_CAN_DUPE
        memory(pointer, 1)[0] = 1
        return 1
      case 6: {
        // SET_MESSAGE: copy before the callback returns.
        const data = memory(pointer, 16)
        this.messages.push(stringAt(data.readBigUInt64LE(0)))

        if (this.messages.length > 32) {
          this.messages.shift()
        }

        return 1
      }
      case 7: // SHUTDOWN
        this.shutdown = true
        return 1
      case 10: {
        // SET_PIXEL_FORMAT
        const format = memory(pointer, 4).readUInt32LE()

        if (![0, 1, 2].includes(format)) {
          return 0
        }

        this.pixelFormat = format
        return 1
      }
      case 15: {
        // GET_VARIABLE
        if (!pointer) {
          return 1
        }

        const data = memory(pointer, 16)
        const option = this.options.get(stringAt(data.readBigUInt64LE(0)))
        data.writeBigUInt64LE(option ? this.#string(option.value) : 0n, 8)
        return 1
      }
      case 16: {
        // SET_VARIABLES: legacy core-option definitions.
        if (!pointer) {
          return 1
        }

        for (let i = 0; i < 4096; i++) {
          const data = memory(pointer + BigInt(i * 16), 16)
          const key = stringAt(data.readBigUInt64LE(0))

          if (key === null) {
            return 1
          }

          const definition = stringAt(data.readBigUInt64LE(8))
          const separator = definition?.indexOf('; ')

          if (separator === undefined || separator < 0) {
            throw new NativeError(`invalid option definition for ${key}`)
          }

          const values = definition.slice(separator + 2).split('|')
          const value = this.#configured[key] ?? values[0]

          if (!values.includes(value)) {
            throw new ConfigError(`unsupported value ${value} for ${key}`)
          }

          this.options.set(key, { description: definition.slice(0, separator), values, value })
        }

        throw new NativeError('unterminated core options array')
      }
      case 17: // GET_VARIABLE_UPDATE: options are immutable during a session.
        memory(pointer, 1)[0] = 0
        return 1
      case 24: // GET_INPUT_DEVICE_CAPABILITIES: joypad only.
        memory(pointer, 8).writeBigUInt64LE(2n)
        return 1
      case 27: // GET_LOG_INTERFACE
        if (!this.#log) {
          return 0
        }

        memory(pointer, 8).writeBigUInt64LE(BigInt(this.#log))
        return 1
      case 32: // SET_SYSTEM_AV_INFO
        this.av = readAV(memory(pointer, 40))
        return 1
      case 37: // SET_GEOMETRY
        this.av = { ...this.av, ...readGeometry(memory(pointer, 20)) }
        return 1
      case 52: // GET_CORE_OPTIONS_VERSION: request the legacy fallback.
        memory(pointer, 4).writeUInt32LE(0)
        return 1
      case 0x1002f: // GET_AUDIO_VIDEO_ENABLE: produce both audio and video.
        memory(pointer, 4).writeUInt32LE(3)
        return 1
      case 0x10033: // GET_INPUT_BITMASKS
        return 1
      default:
        this.unsupported.add(command)
        return 0
    }
  }

  validateOptions () {
    for (const key of Object.keys(this.#configured)) {
      if (!this.options.has(key)) {
        throw new ConfigError(`unknown core option ${key}`)
      }
    }
  }
}

export async function createStorage (config) {
  // Custom storage replaces state-file handling, but battery saves stay local.
  if (config.options.save.module) {
    try {
      const backend = await import(pathToFileURL(config.options.save.module).href)

      if (typeof backend.save !== 'function' || typeof backend.load !== 'function') {
        throw new PersistenceError('custom module must export save(context, data) and load(context)')
      }

      return backend
    } catch (error) {
      throw new PersistenceError(error.message, { cause: error })
    }
  }

  // Binary and content hashes isolate incompatible core builds and different ROMs.
  function location (context) {
    const directory = join(config.paths.saves, context.core.id, context.content.id)
    return { directory, path: join(directory, `${context.slot}.state`) }
  }

  return {
    async save (context, data) {
      await writeAtomic(location(context).path, data)
    },
    async load (context) {
      try {
        return await readFile(location(context).path)
      } catch (error) {
        if (error.code === 'ENOENT') {
          return null
        }

        throw error
      }
    }
  }
}

export async function writeAtomic (path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`

  // Flush the complete sibling file before making it visible under the final name.
  try {
    await writeFile(temporary, data, { flag: 'wx', flush: true })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export class BatteryStorage {
  #directory
  #previous = new Map()

  constructor (saveDirectory, contentId) {
    // Cartridge saves follow the ROM, independently of the core binary version.
    this.#directory = join(saveDirectory, 'battery', contentId)
  }

  async load (core) {
    for (const [id, name] of [
      [0, 'save.srm'],
      [1, 'clock.rtc']
    ]) {
      const initial = core.readBatteryMemory(id)

      if (!initial) {
        continue
      }

      const path = join(this.#directory, name)

      try {
        let saved
        try {
          saved = await readFile(path)
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error
          }
        }

        if (saved) {
          if (saved.length !== initial.length) {
            throw new PersistenceError(`battery file ${path} has ${saved.length} bytes; expected ${initial.length}`)
          }

          core.restoreBatteryMemory(id, saved)
        }

        // An absent file is written on the first flush, even if still unchanged.
        this.#previous.set(id, saved ?? null)
      } catch (error) {
        throw new PersistenceError(`cannot load battery file ${path}: ${error.message}`, { cause: error })
      }
    }
  }

  async save (core) {
    for (const [id, name] of [
      [0, 'save.srm'],
      [1, 'clock.rtc']
    ]) {
      const data = core.readBatteryMemory(id)

      if (!data || data.equals(this.#previous.get(id) ?? Buffer.alloc(0))) {
        continue
      }

      const path = join(this.#directory, name)

      try {
        await writeAtomic(path, data)

        // Advance only after successful replacement so failures remain retryable.
        this.#previous.set(id, data)
      } catch (error) {
        throw new PersistenceError(`cannot save battery file ${path}: ${error.message}`, { cause: error })
      }
    }
  }
}

let active = false

export class Core {
  environment
  info
  contentId
  coreId
  frame = null
  stats = { frames: 0, videoFrames: 0, duplicatedFrames: 0, audioFrames: 0, audioPeak: 0 }
  #lib
  #functions
  #initialized = false
  #loaded = false
  #inCall = false
  #failure = null
  #retained = []
  #buttons = 0
  #snapshot = 0
  #closed = false
  #audioSink
  #singleAudio = Buffer.alloc(4096)
  #singleLength = 0
  #singleRate

  static async load (config, romPath) {
    if (active) {
      throw new StateError('only one native core session may be active per JS environment')
    }

    // Reserve the process-global core before asynchronous reads permit another load.
    active = true
    const core = new Core()

    try {
      // Hash the exact loaded bytes to isolate content and serialized-state namespaces.
      const [binary, content] = await Promise.all([readFile(config.paths.core), readFile(romPath)])
      core.coreId = createHash('sha256').update(binary).digest('hex')
      core.contentId = createHash('sha256').update(content).digest('hex')

      const handle = openLibrary(config.paths.core)
      core.#lib = handle.lib
      core.#functions = handle.functions

      if (core.#call('retro_api_version') !== 1) {
        throw new NativeError('unsupported libretro API version')
      }

      const info = Buffer.alloc(32)
      core.#call('retro_get_system_info', info)
      core.info = {
        name: stringAt(info.readBigUInt64LE(0)),
        version: stringAt(info.readBigUInt64LE(8)),
        extensions: stringAt(info.readBigUInt64LE(16)),
        needFullpath: Boolean(info[24])
      }

      // Install all frontend callbacks before initialization can invoke them. Some cores
      // request the log interface during retro_set_environment and crash without one.
      const log = core.#callback(['int32', 'pointer'], 'void', (level, format) => core.environment.log(level, format))
      core.environment = new Environment(config, log)
      core.#register('environment', ['uint32', 'pointer'], 'bool', (command, pointer) =>
        core.environment.handle(command, pointer))
      core.#register('video_refresh', ['pointer', 'uint32', 'uint32', 'uint64'], 'void', (...args) =>
        core.#video(...args))

      // Single-sample cores share a reusable PCM batch with the same synchronous sink.
      core.#register('audio_sample', ['int16', 'int16'], 'void', (left, right) => {
        core.stats.audioFrames++
        core.stats.audioPeak = Math.max(core.stats.audioPeak, Math.abs(left), Math.abs(right))

        if (core.#audioSink) {
          const rate = core.environment.av.sampleRate

          if (core.#singleLength && core.#singleRate !== rate) {
            core.#flushAudio()
          }

          core.#singleRate = rate
          core.#singleAudio.writeInt16LE(left, core.#singleLength)
          core.#singleAudio.writeInt16LE(right, core.#singleLength + 2)
          core.#singleLength += 4

          if (core.#singleLength === core.#singleAudio.length) {
            core.#flushAudio()
          }
        }
      })
      core.#register('audio_sample_batch', ['pointer', 'uint64'], 'uint64', (pointer, frames) => {
        const count = Number(frames)

        if (count > 0) {
          const samples = memory(pointer, count * 4)

          for (let i = 0; i < samples.length; i += 2) {
            core.stats.audioPeak = Math.max(core.stats.audioPeak, Math.abs(samples.readInt16LE(i)))
          }

          core.#audioSink?.(samples, core.environment.av.sampleRate)
        }

        core.stats.audioFrames += count
        return frames
      })

      // Hold one joypad snapshot for every input query within the core's poll cycle.
      core.#register('input_poll', [], 'void', () => {
        core.#snapshot = core.#buttons
      })
      core.#register('input_state', ['uint32', 'uint32', 'uint32', 'uint32'], 'int16', (port, device, index, id) => {
        if (port !== 0 || device !== 1 || index !== 0) {
          return 0
        }

        if (id === 256) {
          return (core.#snapshot << 16) >> 16
        }

        return id < 16 ? (core.#snapshot >> id) & 1 : 0
      })

      // Mark initialization before calling C so failures still take the matching teardown path.
      core.#initialized = true
      core.#call('retro_init')

      // Full-path cores read the file themselves; other cores borrow the supplied content bytes.
      const path = Buffer.from(`${romPath}\0`)
      const game = Buffer.alloc(32)
      game.writeBigUInt64LE(pointerOf(path), 0)

      if (!core.info.needFullpath) {
        game.writeBigUInt64LE(pointerOf(content), 8)
        game.writeBigUInt64LE(BigInt(content.length), 16)
      }

      // Retain content and strings through unload, including cores that keep them.
      core.#retained = [path, content, game]
      core.#loaded = Boolean(core.#call('retro_load_game', game))

      if (!core.#loaded) {
        throw new NativeError('core rejected the content')
      }

      core.environment.validateOptions()

      // Establish timing and controller ports only after the core has accepted content.
      const av = Buffer.alloc(40)
      core.#call('retro_get_system_av_info', av)
      core.environment.av = readAV(av)
      core.#call('retro_set_controller_port_device', 0, 1)
      core.#call('retro_set_controller_port_device', 1, 0)
      core.#validateAV()

      return core
    } catch (error) {
      core.close()

      if (error.code?.startsWith('PRINCIPE_')) {
        throw error
      }

      throw new NativeError(error.message, { cause: error })
    }
  }

  #register (name, args, result, callback) {
    this.#call(`retro_set_${name}`, this.#callback(args, result, callback))
  }

  #callback (args, result, callback) {
    // SAFETY: Synchronous core callbacks execute on the thread that loaded it.
    // Exceptions are deferred until C returns; no Promise crosses this boundary.
    return this.#lib.registerCallback({ arguments: args, return: result }, (...values) => {
      if (this.#failure) {
        return result === 'uint64' ? 0n : 0
      }

      try {
        return callback(...values)
      } catch (error) {
        this.#failure = error
        return result === 'uint64' ? 0n : 0
      }
    })
  }

  #call (name, ...args) {
    this.#inCall = true

    try {
      // SAFETY: Symbols use the checked libretro ABI; argument owners remain live.
      const result = this.#functions[name](...args)

      // Even if a frontend callback failed, a successful native load still needs
      // retro_unload_game() during cleanup.
      if (name === 'retro_load_game') {
        this.#loaded = Boolean(result)
      }

      if (this.#failure) {
        throw this.#failure
      }

      return result
    } finally {
      this.#inCall = false
    }
  }

  #video (pointer, width, height, pitchValue) {
    if (!pointer) {
      this.stats.duplicatedFrames++
      return
    }

    const pitch = Number(pitchValue)
    const bytesPerPixel = this.environment.pixelFormat === 1 ? 4 : 2
    const rowBytes = width * bytesPerPixel

    if (!width || !height || pitch < rowBytes || width > 16384 || height > 16384) {
      throw new NativeError('invalid software framebuffer geometry')
    }

    // Copy rows inside the callback. The core owns the source, including padding;
    // the last row need only contain its visible pixels, not a full extra pitch.
    const source = memory(pointer, (height - 1) * pitch + rowBytes)
    const size = rowBytes * height

    if (!this.frame || this.frame.data.length !== size) {
      this.frame = { data: Buffer.alloc(size) }
    }

    for (let y = 0; y < height; y++) {
      source.copy(this.frame.data, y * rowBytes, y * pitch, y * pitch + rowBytes)
    }

    Object.assign(this.frame, { width, height, pitch: rowBytes, pixelFormat: this.environment.pixelFormat })
    this.stats.videoFrames++
  }

  #validateAV () {
    const { fps, sampleRate } = this.environment.av

    if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new NativeError('core provided invalid audio/video timing')
    }
  }

  #ready () {
    if (!this.#loaded || this.#inCall) {
      throw new StateError('core is closed or executing')
    }
  }

  setInput (mask) {
    this.#ready()

    if (!Number.isInteger(mask) || mask < 0 || mask > 65535) {
      throw new StateError('joypad mask must be an unsigned 16-bit integer')
    }

    this.#buttons = mask
  }

  setAudioSink (sink) {
    this.#ready()

    if (sink !== null && typeof sink !== 'function') {
      throw new StateError('audio sink must be a synchronous function or null')
    }

    this.#audioSink = sink
    this.#singleLength = 0
  }

  #flushAudio () {
    if (this.#singleLength) {
      this.#audioSink(this.#singleAudio.subarray(0, this.#singleLength), this.#singleRate)
      this.#singleLength = 0
    }
  }

  runFrame () {
    this.#ready()

    if (this.environment.shutdown) {
      return false
    }

    this.#call('retro_run')
    this.#flushAudio()
    this.#validateAV()
    this.stats.frames++
    return true
  }

  #batteryMemory (id) {
    this.#ready()

    // libretro.h reserves 0 for SAVE_RAM and 1 for RTC. Never persist system RAM.
    if (id !== 0 && id !== 1) {
      throw new NativeError('unsupported battery memory region')
    }

    const size = Number(this.#call('retro_get_memory_size', id))

    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) {
      throw new NativeError('invalid battery memory size')
    }

    if (size === 0) {
      return null
    }

    const pointer = this.#call('retro_get_memory_data', id)

    // SAFETY: The core is loaded and idle. Query the pointer anew each time,
    // and never retain the borrowed view across a core call or asynchronous I/O.
    return memory(pointer, size)
  }

  readBatteryMemory (id) {
    const data = this.#batteryMemory(id)
    return data ? Buffer.from(data) : null
  }

  restoreBatteryMemory (id, data) {
    const target = this.#batteryMemory(id)

    if (!target || !Buffer.isBuffer(data) || target.length !== data.length) {
      throw new NativeError('battery memory size does not match the core')
    }

    // SAFETY: The borrowed region remains live until this synchronous copy ends.
    data.copy(target)
  }

  serialize () {
    this.#ready()

    const size = Number(this.#call('retro_serialize_size'))

    if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 * 1024) {
      throw new NativeError('core does not provide a supported state size')
    }

    const data = Buffer.alloc(size)

    if (!this.#call('retro_serialize', data, BigInt(size))) {
      throw new NativeError('serialization failed')
    }

    return data
  }

  unserialize (data) {
    this.#ready()

    if (!Buffer.isBuffer(data) || !data.length || data.length > 256 * 1024 * 1024) {
      throw new StateError('load must return a nonempty Buffer of at most 256 MiB, or null')
    }

    if (!this.#call('retro_unserialize', data, BigInt(data.length))) {
      throw new NativeError('core rejected the saved state')
    }

    this.frame = null
  }

  close () {
    if (this.#closed) {
      return
    }

    if (this.#inCall) {
      throw new StateError('cannot close a core inside its callback')
    }

    try {
      // SAFETY: Callbacks and retained buffers outlive unload/deinit. No native
      // callbacks may run after closing the library that owns their trampolines.
      try {
        if (this.#loaded) {
          this.#loaded = false
          this.#functions.retro_unload_game()
        }
      } finally {
        if (this.#initialized) {
          this.#initialized = false
          this.#functions.retro_deinit()
        }
      }
    } finally {
      this.#lib?.close()
      this.#lib = null
      this.#retained = []
      this.#closed = true
      active = false
    }
  }
}

export const joypadButtons = [
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
]

function validateSlot (slot) {
  // Slots become filenames, so reject path separators and traversal components.
  return typeof slot === 'number'
    ? Number.isSafeInteger(slot) && slot > 0
    : typeof slot === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(slot)
}

export async function loadSession (romPath, configPath) {
  if (typeof romPath !== 'string' || !romPath.length) {
    throw new ConfigError('a ROM path is required')
  }

  const content = resolve(romPath)
  const config = await loadConfig(configPath)
  const storage = await createStorage(config)

  // The core may use these directories during initialization.
  await mkdir(config.paths.system, { recursive: true })
  await mkdir(config.paths.saves, { recursive: true })

  const core = await Core.load(config, content)
  let audio

  try {
    const battery = new BatteryStorage(config.paths.saves, core.contentId)

    // libretro exposes battery memory after load_game, before the first run.
    await battery.load(core)

    // Open playback after battery restoration, before exposing the interactive session.
    if (config.options.audio.enabled) {
      audio = await SDLAudio.open({ ...config.options.audio, path: config.paths.audio }, core.environment.av.sampleRate)
    }

    return new Session(config, core, storage, audio, content, battery)
  } catch (error) {
    try {
      core.setAudioSink(null)
      core.close()
    } finally {
      audio?.close()
    }

    throw error
  }
}

class Session {
  #content
  #core
  #storage
  #battery
  #closing
  #slot
  #numericSlot = 1
  #pending = null
  #running = false
  #closed = false
  #stopped = false
  #mask = 0
  #taps = 0
  #renderer
  #input
  #inputFailure
  #status = 'Ready'
  #audio
  #paused = false
  #audioVideoSkips = 0

  constructor (config, core, storage, audio, content, battery) {
    this.#content = content
    this.#core = core
    this.#storage = storage
    this.#battery = battery
    this.#audio = audio

    if (audio) {
      core.setAudioSink((samples, rate) => audio.write(samples, rate))
    }

    this.selectSlot(config.options.save.initialSlot)

    this.#status = 'Waiting for Kitty keyboard'

    // Keyboard events and native terminal replies must use the same incremental parser.
    this.#input = new KittyInput(config.bindings, {
      onAction: (binding, pressed) => this.#handleKey(binding, pressed),
      onResponse: data => this.#renderer.processResponse(data),
      onFocus: focused => {
        if (!focused) {
          this.#taps = 0
        }

        this.#status = focused ? 'Focused' : 'Focus lost; buttons released'
      },
      onError: error => {
        this.#inputFailure = error
        this.stop()
      }
    })

    try {
      this.#renderer = new OpenTUI(
        { ...config.options.video, ...config.options.ui, path: config.paths.video },
        {
          onData: data => this.#input.feed(data),
          onError: error => {
            this.#inputFailure = error
            this.stop()
          }
        }
      )
      this.#input.start(config.options.ui.protocolTimeoutMs)
    } catch (error) {
      this.#input.close()
      this.#renderer?.close()
      throw error
    }
  }

  get slot () {
    return this.#slot
  }

  async #handleKey (binding, pressed) {
    try {
      const persistence = binding.action === 'saveState' || binding.action === 'loadState'
      const slot = binding.slot ?? this.#slot

      if (pressed && persistence && this.#pending) {
        this.#status = 'Save/load already in progress'
        return
      }

      if (pressed && persistence) {
        this.#status = `${binding.action === 'saveState' ? 'Saving' : 'Loading'} slot ${slot}...`
      }

      const result = this.dispatch(binding, pressed)

      if (pressed && persistence) {
        const found = await result
        this.#status = found
          ? `${binding.action === 'saveState' ? 'Saved' : 'Loaded'} slot ${slot}`
          : `Slot ${slot} is empty`
      } else if (pressed && binding.action !== 'joypad') {
        if (binding.action !== 'togglePause') {
          this.#status = binding.action === 'quit' ? 'Stopping' : `Selected slot ${this.#slot}`
        }
      } else if (this.#status === 'Waiting for Kitty keyboard') {
        this.#status = 'Ready'
      }
    } catch (error) {
      // Async shortcut errors belong to the action, not the stdin EventEmitter.
      // Keep the game running and show the stable error code in the status row.
      this.#status = `${error.code ?? 'PRINCIPE_INPUT'}: ${error.message}`
    }
  }

  #present () {
    const status = this.#input?.summary()
    const message = this.#status === 'Waiting for Kitty keyboard' && status?.supported ? 'Ready' : this.#status
    this.#renderer?.setStatus(`Slot ${this.#slot}${this.#paused ? ' | Paused' : ''} | ${message}`)

    const frame = this.#core.frame
    const audio = this.#audio?.summary()
    const device = audio?.device?.name ?? 'none'

    // Restoring a state invalidates the old video frame until emulation resumes.
    this.#renderer?.setInfo(`${frame ? `${frame.width}x${frame.height}` : 'Waiting for video'} | Audio: ${device}`)
    this.#renderer?.render(this.#core.frame, this.#core.environment.av, this.#core.stats.videoFrames)
  }

  async #waitForPersistence () {
    while (this.#pending) {
      this.#present()
      // Keep status/resize responsive while emulation is paused. The caller of
      // saveState/loadState owns failures; the runner only waits for completion.
      await Promise.race([this.#pending.catch(() => {}), sleep(33)])
    }
  }

  #ready () {
    if (this.#closed) {
      throw new StateError('session is closed')
    }
  }

  selectSlot (slot) {
    this.#ready()

    if (!validateSlot(slot)) {
      throw new StateError('slot must be a positive safe integer or a 1–64 character alphanumeric name with - or _')
    }

    this.#slot = slot

    if (typeof slot === 'number') {
      this.#numericSlot = slot
    }

    return slot
  }

  dispatch (binding, pressed = true) {
    this.#ready()

    if (binding.action === 'joypad') {
      const index = joypadButtons.indexOf(binding.button)

      if (index < 0) {
        throw new StateError(`unknown joypad button ${binding.button}`)
      }

      const bit = 1 << index
      this.#mask = pressed ? this.#mask | bit : this.#mask & ~bit

      if (pressed) {
        // Terminal chunks can contain a whole tap between two emulated frames.
        // Latch each press for one poll so short Start/jump taps are not lost.
        this.#taps |= bit
      }

      this.#core.setInput(this.#mask)
      return
    }

    // Frontend commands fire only on presses; releases are meaningful only for joypad state.
    if (!pressed) {
      return
    }

    switch (binding.action) {
      case 'selectSlot':
        return this.selectSlot(binding.slot)
      case 'previousSlot':
        return this.selectSlot(Math.max(1, this.#numericSlot - 1))
      case 'nextSlot':
        return this.selectSlot(this.#numericSlot + 1)
      case 'saveState':
        return this.saveState(binding.slot)
      case 'loadState':
        return this.loadState(binding.slot)
      case 'quit':
        this.stop()
        break
      case 'togglePause':
        this.#paused = !this.#paused
        this.#status = this.#paused ? 'Paused' : 'Resumed'

        if (this.#paused) {
          this.#audio?.pause()
        } else if (this.#running && !this.#pending) {
          this.#audio?.resume()
        }

        break
    }
  }

  #context (slot) {
    if (!validateSlot(slot)) {
      throw new StateError('invalid persistence slot')
    }

    return Object.freeze({
      core: Object.freeze({ ...this.#core.info, id: this.#core.coreId }),
      content: Object.freeze({ path: this.#content, id: this.#core.contentId }),
      slot: String(slot)
    })
  }

  #persist (operation, slot) {
    this.#ready()

    if (this.#pending) {
      throw new StateError('a persistence operation is already in progress')
    }

    const context = this.#context(slot ?? this.#slot)
    this.#audio?.pause()

    // Reserve the pause before invoking arbitrary user code, including its first
    // synchronous segment. run() waits for this promise at every frame boundary.
    const pending = Promise.resolve().then(async () => {
      try {
        if (operation === 'save') {
          const data = this.#core.serialize()
          await this.#storage.save(context, data)
          return true
        }

        const data = await this.#storage.load(context)

        if (data === null) {
          return false
        }

        // Already queued PCM belongs to the old timeline, including any SDL
        // resampler history. Clear it before the core restores a snapshot.
        this.#audio?.reset()
        this.#core.unserialize(data)
        return true
      } catch (error) {
        throw new PersistenceError(error.message, { cause: error })
      } finally {
        this.#pending = null

        if (this.#running && !this.#paused) {
          this.#audio?.resume()
        }
      }
    })

    this.#pending = pending
    return pending
  }

  saveState (slot) {
    return this.#persist('save', slot)
  }

  loadState (slot) {
    return this.#persist('load', slot)
  }

  stop () {
    this.#stopped = true
  }

  async run ({ frames = null } = {}) {
    this.#ready()

    if (this.#running || (frames !== null && (!Number.isSafeInteger(frames) || frames < 1))) {
      throw new StateError('run requires a positive frame count or null, and an idle runner')
    }

    this.#running = true
    this.#stopped = false
    let deadline = performance.now()
    let nextBatterySave = deadline + 10000
    const limit = frames ?? Infinity

    try {
      // Negotiate before the first emulated frame or audio playback. Polling uses
      // the existing incremental input parser and keeps stop/signals responsive.
      while (!this.#stopped) {
        if (this.#inputFailure) {
          throw this.#inputFailure
        }

        if (this.#renderer.ready() && this.#input.summary().supported) {
          break
        }

        await sleep(10)
      }

      // Reset pacing after negotiation so startup delay never creates a catch-up burst.
      deadline = performance.now()
      nextBatterySave = deadline + 10000

      if (!this.#paused && !this.#pending) {
        this.#audio?.resume()
      }

      // Persistence and pause hold emulation at frame boundaries while UI work stays responsive.
      for (let i = 0; i < limit && !this.#stopped;) {
        if (this.#pending) {
          await this.#waitForPersistence()
          deadline = performance.now()
        }

        if (this.#stopped) {
          break
        }

        // Take owned snapshots at a frame boundary. Writes are serialized with
        // emulation and persistence; no timer can race unload or a state restore.
        if (performance.now() >= nextBatterySave) {
          await this.#battery.save(this.#core)
          nextBatterySave = performance.now() + 10000
        }

        if (this.#paused) {
          this.#present()
          await sleep(16)
          deadline = performance.now()
          continue
        }

        // Let queued audio throttle emulation and protect its budget before running another frame.
        const audioState = this.#audio?.feedback()

        if (audioState?.waitMs) {
          this.#present()
          await sleep(audioState.waitMs)
          deadline = performance.now()
          continue
        }

        // Include latched taps for one frame, then return to the current held-button mask.
        this.#core.setInput(this.#mask | this.#taps)

        if (!this.#core.runFrame()) {
          break
        }

        this.#taps = 0
        i++

        // Presentation can be skipped independently of emulation when audio is running low.
        if (!audioState || audioState.allowVideo) {
          this.#present()
        } else if (this.#renderer) {
          this.#audioVideoSkips++
        }

        const period = 1000 / this.#core.environment.av.fps
        deadline += period

        // Bound catch-up after a long stall rather than starving input forever.
        if (deadline < performance.now() - period * 4) {
          deadline = performance.now()
        }

        await sleep(Math.max(0, deadline - performance.now()))
      }

      // Do not return while an asynchronous save/load still owns the paused core.
      if (this.#pending) {
        await this.#waitForPersistence()
      }

      return this.summary()
    } finally {
      this.#running = false
      this.#audio?.pause()
    }
  }

  summary () {
    if (this.#inputFailure) {
      throw this.#inputFailure
    }

    const frame = this.#core.frame
    return {
      core: this.#core.info,
      contentId: this.#core.contentId,
      timing: this.#core.environment.av,
      ...this.#core.stats,
      video: this.#renderer.summary(),
      audio: this.#audio?.summary() ?? { backend: 'none' },
      audioVideoSkips: this.#audioVideoSkips,
      paused: this.#paused,
      input: this.#input?.summary() ?? { protocol: null },
      status: this.#status,
      frame: frame
        ? {
            width: frame.width,
            height: frame.height,
            pitch: frame.pitch,
            pixelFormat: ['0RGB1555', 'XRGB8888', 'RGB565'][frame.pixelFormat],
            sha256: createHash('sha256').update(frame.data).digest('hex')
          }
        : null,
      slot: this.#slot,
      shutdownRequested: this.#core.environment.shutdown,
      unsupportedEnvironmentCommands: [...this.#core.environment.unsupported].sort((a, b) => a - b),
      messages: [...this.#core.environment.messages],
      logs: [...this.#core.environment.logs]
    }
  }

  close () {
    if (this.#closing) {
      return this.#closing
    }

    if (this.#running || this.#pending) {
      throw new StateError('stop and await run/save/load before closing')
    }

    this.#closed = true
    this.#closing = this.#shutdown()
    return this.#closing
  }

  async #shutdown () {
    // Keep the core loaded for the final battery flush, and release audio even if cleanup fails.
    try {
      this.#input?.close()
      this.#renderer?.close()
    } finally {
      try {
        await this.#battery.save(this.#core)
      } finally {
        try {
          this.#core.setAudioSink(null)
          this.#core.close()
        } finally {
          this.#audio?.close()
        }
      }
    }
  }
}
