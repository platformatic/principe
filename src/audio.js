import { dlopen, toBuffer, toString } from 'node:ffi'
import { AudioError } from './errors.js'
import { libraryPath } from './config.js'

const AUDIO = 0x10
const S16LE = 0x8010
const DEFAULT_PLAYBACK = 0xffffffff
const signatures = {
  SDL_GetVersion: { arguments: [], return: 'int32' },
  SDL_InitSubSystem: { arguments: ['uint32'], return: 'bool' },
  SDL_QuitSubSystem: { arguments: ['uint32'], return: 'void' },
  SDL_GetError: { arguments: [], return: 'pointer' },
  SDL_free: { arguments: ['pointer'], return: 'void' },
  SDL_GetAudioPlaybackDevices: { arguments: ['pointer'], return: 'pointer' },
  SDL_GetAudioDeviceName: { arguments: ['uint32'], return: 'pointer' },
  SDL_GetAudioDeviceFormat: { arguments: ['uint32', 'pointer', 'pointer'], return: 'bool' },
  SDL_OpenAudioDeviceStream: { arguments: ['uint32', 'pointer', 'pointer', 'pointer'], return: 'pointer' },
  SDL_GetAudioStreamDevice: { arguments: ['pointer'], return: 'uint32' },
  SDL_DestroyAudioStream: { arguments: ['pointer'], return: 'void' },
  SDL_PutAudioStreamData: { arguments: ['pointer', 'pointer', 'int32'], return: 'bool' },
  SDL_GetAudioStreamQueued: { arguments: ['pointer'], return: 'int32' },
  SDL_SetAudioStreamFormat: { arguments: ['pointer', 'pointer', 'pointer'], return: 'bool' },
  SDL_SetAudioStreamGain: { arguments: ['pointer', 'float32'], return: 'bool' },
  SDL_SetAudioStreamFrequencyRatio: { arguments: ['pointer', 'float32'], return: 'bool' },
  SDL_PauseAudioStreamDevice: { arguments: ['pointer'], return: 'bool' },
  SDL_ResumeAudioStreamDevice: { arguments: ['pointer'], return: 'bool' },
  SDL_ClearAudioStream: { arguments: ['pointer'], return: 'bool' }
}

export class SDLAudio {
  #lib
  #functions
  #stream = 0n
  #initialized = false
  #closed = false
  #options
  #spec = Buffer.alloc(12)
  #rate
  #ratio = 1
  #playing = false
  #suspended = true
  #backpressure = false
  #quantumMs = 0
  #targetMs = 0
  #stats = {
    submittedFrames: 0,
    droppedFrames: 0,
    starvationEvents: 0,
    overflowEvents: 0,
    resets: 0,
    rateChanges: 0,
    maxQueuedMs: 0
  }

  devices = []
  device
  version
  path

  static open (options, rate) {
    return new SDLAudio(options.path ?? libraryPath('audio'), options, rate)
  }

  constructor (path, options, rate) {
    this.path = path
    this.#options = options

    try {
      // SAFETY: These signatures target SDL 3.2+ on the supported LE64 platforms.
      const { lib, functions } = dlopen(path, signatures)
      this.#lib = lib
      this.#functions = functions

      this.version = this.#call('SDL_GetVersion')

      if (this.version < 3002000 || this.version >= 4000000) {
        throw new AudioError('SDL 3.2 or later in the 3.x series is required')
      }

      // Device enumeration is shared by playback sessions and the standalone audio-list command.
      this.#check('SDL_InitSubSystem', AUDIO)
      this.#initialized = true

      const count = Buffer.alloc(4)
      const pointer = this.#call('SDL_GetAudioPlaybackDevices', count)

      if (!pointer) {
        throw this.#error('SDL_GetAudioPlaybackDevices')
      }

      try {
        const length = count.readInt32LE()

        if (length < 0 || length > 65536) {
          throw new AudioError('invalid playback device count')
        }

        // SAFETY: SDL allocated count uint32 IDs. Copy before SDL_free below.
        const ids = toBuffer(pointer, length * 4)

        for (let i = 0; i < length; i++) {
          const id = ids.readUInt32LE(i * 4)
          this.devices.push({ id, name: this.#deviceName(id) })
        }
      } finally {
        this.#call('SDL_free', pointer)
      }

      // Listing devices stops here without opening a playback stream.
      if (rate === undefined) {
        return
      }

      const selected =
        options.device === null ? DEFAULT_PLAYBACK : this.devices.find(device => device.name === options.device)?.id

      if (selected === undefined) {
        throw new AudioError(`playback device not found: ${options.device}`)
      }

      this.#setSpec(rate)

      // No JS callback is registered with SDL: its audio thread only consumes
      // copied PCM. The libretro callbacks that submit it stay on Node's thread.
      this.#stream = this.#call('SDL_OpenAudioDeviceStream', selected, this.#spec, null, null)

      if (!this.#stream) {
        throw this.#error('SDL_OpenAudioDeviceStream')
      }

      // Use the actual device quantum to avoid configuring a target below its buffering needs.
      const id = this.#call('SDL_GetAudioStreamDevice', this.#stream)
      const output = Buffer.alloc(12)
      const quantum = Buffer.alloc(4)
      this.#check('SDL_GetAudioDeviceFormat', id, output, quantum)
      this.device = {
        id,
        name: this.#deviceName(id),
        format: output.readUInt32LE(0),
        channels: output.readInt32LE(4),
        sampleRate: output.readInt32LE(8),
        sampleFrames: quantum.readInt32LE()
      }

      if (this.device.sampleRate <= 0 || this.device.channels <= 0 || this.device.sampleFrames < 0) {
        throw new AudioError('SDL provided invalid playback device timing')
      }

      this.#quantumMs = (this.device.sampleFrames * 1000) / this.device.sampleRate
      this.#targetMs = Math.max(options.latencyMs, this.#quantumMs * 2)

      const minimumMaximum = this.#targetMs + Math.max(20, this.#quantumMs)

      if (minimumMaximum >= options.maxLatencyMs) {
        throw new AudioError(`maxLatencyMs must exceed ${Math.ceil(minimumMaximum)} ms for this device`)
      }

      this.#check('SDL_SetAudioStreamGain', this.#stream, options.volume)
      this.#check('SDL_SetAudioStreamFrequencyRatio', this.#stream, this.#ratio)
    } catch (error) {
      this.close()
      throw error.code === 'PRINCIPE_AUDIO' ? error : new AudioError(error.message, { cause: error })
    }
  }

  #call (name, ...args) {
    // SAFETY: Native objects belong to this live library. SDL copies supplied
    // PCM/spec buffers synchronously, so borrowed libretro data never escapes.
    return this.#functions[name](...args)
  }

  #error (operation) {
    const pointer = this.#call('SDL_GetError')

    // SAFETY: SDL owns this thread-local, NUL-terminated error string.
    return new AudioError(`${operation}: ${pointer ? toString(pointer) : 'unknown SDL error'}`)
  }

  #check (name, ...args) {
    if (!this.#call(name, ...args)) {
      throw this.#error(name)
    }
  }

  #deviceName (id) {
    const pointer = this.#call('SDL_GetAudioDeviceName', id)

    if (!pointer) {
      throw this.#error('SDL_GetAudioDeviceName')
    }

    // SAFETY: Copy the SDL-owned, NUL-terminated name before further SDL calls.
    return toString(pointer)
  }

  #setSpec (rate) {
    if (!Number.isFinite(rate) || rate < 1000 || rate > 384000) {
      throw new AudioError(`unsupported core sample rate ${rate}`)
    }

    // SDL needs an integer sample rate; the ratio retains the core's fractional timing.
    this.#rate = rate
    this.#ratio = rate / Math.round(rate)
    this.#spec.writeUInt32LE(S16LE, 0)
    this.#spec.writeInt32LE(2, 4)
    this.#spec.writeInt32LE(Math.round(rate), 8)
  }

  #queuedMs () {
    const bytes = this.#call('SDL_GetAudioStreamQueued', this.#stream)

    if (bytes < 0) {
      throw this.#error('SDL_GetAudioStreamQueued')
    }

    return (bytes * 1000) / (this.#rate * 4)
  }

  #startIfReady () {
    if (!this.#suspended && !this.#playing && this.#queuedMs() >= this.#targetMs) {
      this.#check('SDL_ResumeAudioStreamDevice', this.#stream)
      this.#playing = true
    }
  }

  write (samples, rate) {
    if (this.#closed) {
      throw new AudioError('audio backend is closed')
    }

    // Rate changes invalidate queued PCM and the resampler's previous timeline.
    if (rate !== this.#rate) {
      this.reset()
      this.#setSpec(rate)
      this.#check('SDL_SetAudioStreamFormat', this.#stream, this.#spec, null)
      this.#check('SDL_SetAudioStreamFrequencyRatio', this.#stream, this.#ratio)
      this.#stats.rateChanges++
    }

    if (!Buffer.isBuffer(samples) || samples.length % 4 !== 0) {
      throw new AudioError('PCM must contain complete signed-16 stereo frames')
    }

    if (!samples.length) {
      return
    }

    // Bound latency by dropping stale audio, keeping the newest complete stereo frames.
    const capacity = Math.floor((this.#options.maxLatencyMs * this.#rate) / 1000) * 4

    if (this.#queuedMs() + (samples.length * 1000) / (this.#rate * 4) > this.#options.maxLatencyMs) {
      this.#stats.droppedFrames += Math.round((this.#queuedMs() * this.#rate) / 1000)
      this.reset()
      this.#stats.overflowEvents++
    }

    if (samples.length > capacity) {
      this.#stats.droppedFrames += (samples.length - capacity) / 4
      samples = samples.subarray(samples.length - capacity)
    }

    // Submit only owned or synchronously borrowed PCM, then start once the target queue is ready.
    this.#check('SDL_PutAudioStreamData', this.#stream, samples, samples.length)
    this.#stats.submittedFrames += samples.length / 4
    this.#stats.maxQueuedMs = Math.max(this.#stats.maxQueuedMs, this.#queuedMs())
    this.#startIfReady()
  }

  feedback () {
    const queuedMs = this.#queuedMs()

    if (this.#playing && !this.#suspended && queuedMs === 0) {
      // Zero queued input is a starvation observation, not a device-level xrun
      // counter: a hardware buffer may still be playing. Re-prime once per event.
      this.#stats.starvationEvents++
      this.reset()
    }

    // Smooth drift correction instead of changing the playback ratio abruptly each frame.
    if (this.#playing && !this.#suspended) {
      const maximum = this.#options.maxRateCorrection
      const correction = Math.max(-maximum, Math.min(maximum, ((queuedMs - this.#targetMs) / this.#targetMs) * maximum))
      const desired = (this.#rate / Math.round(this.#rate)) * (1 + correction)

      this.#ratio += (desired - this.#ratio) * 0.02
      this.#check('SDL_SetAudioStreamFrequencyRatio', this.#stream, this.#ratio)
    }

    // Hysteresis keeps the runner throttled until the queue falls back to its target.
    if (queuedMs > this.#options.maxLatencyMs - Math.max(20, this.#quantumMs)) {
      this.#backpressure = true
    } else if (queuedMs <= this.#targetMs) {
      this.#backpressure = false
    }

    return {
      queuedMs,
      waitMs: this.#backpressure && this.#playing ? Math.min(10, Math.max(1, queuedMs - this.#targetMs)) : 0,
      // Protect the audio budget by skipping expensive presentation when low.
      allowVideo: this.#playing && queuedMs >= Math.max(this.#quantumMs, this.#targetMs / 3)
    }
  }

  pause () {
    this.#check('SDL_PauseAudioStreamDevice', this.#stream)
    this.#suspended = true
    this.#playing = false
  }

  resume () {
    this.#suspended = false
    this.#startIfReady()
  }

  reset () {
    // Stop and discard the old timeline before restoring the base sample-rate ratio.
    this.#check('SDL_PauseAudioStreamDevice', this.#stream)
    this.#check('SDL_ClearAudioStream', this.#stream)
    this.#playing = false
    this.#backpressure = false

    this.#ratio = this.#rate / Math.round(this.#rate)
    this.#check('SDL_SetAudioStreamFrequencyRatio', this.#stream, this.#ratio)
    this.#stats.resets++
  }

  summary () {
    return {
      backend: 'sdl3',
      path: this.path,
      version: this.version,
      device: this.device,
      sampleRate: this.#rate,
      targetLatencyMs: this.#targetMs,
      queuedMs: this.#stream ? this.#queuedMs() : 0,
      frequencyRatio: this.#ratio,
      ...this.#stats
    }
  }

  close () {
    if (this.#closed) {
      return
    }

    this.#closed = true

    // Destroy the stream before quitting the subsystem, and keep the library live through both.
    try {
      if (this.#stream) {
        this.#call('SDL_DestroyAudioStream', this.#stream)
        this.#stream = 0n
      }
    } finally {
      try {
        if (this.#initialized) {
          this.#call('SDL_QuitSubSystem', AUDIO)
        }
      } finally {
        this.#lib?.close()
      }
    }
  }
}
