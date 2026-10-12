import { VideoError } from './errors.js'
import { dlopen } from 'node:ffi'
import { writeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { VideoOutput } from './video-output.js'

const start = Buffer.from('\x1b_G')
const stop = Buffer.from('\x1b\\')
const index = Buffer.from('-1')

// The native feed publishes complete frames. Only placement headers are decoded;
// compressed/base64 image payloads and all unrelated bytes remain untouched.
export function fixVideoIndex (data) {
  const parts = []
  let copied = 0
  let offset = 0

  while ((offset = data.indexOf(start, offset)) !== -1) {
    const end = data.indexOf(stop, offset + start.length)

    if (end === -1) {
      break
    }

    // Headers end before payload data; never interpret image bytes as placement parameters.
    const separator = data.indexOf(59, offset + start.length)
    const headerEnd = separator >= 0 && separator < end ? separator : end
    const headerStart = offset + start.length
    const header = data.toString('ascii', headerStart, headerEnd)

    if (/(?:^|,)a=p(?:,|$)/.test(header)) {
      const match = /(?:^|,)z=(-?\d+)(?=,|$)/.exec(header)

      if (match && match[1] !== '-1') {
        const valueStart = headerStart + match.index + match[0].length - match[1].length
        parts.push(data.subarray(copied, valueStart), index)
        copied = valueStart + match[1].length
      }
    }

    offset = end + stop.length
  }

  if (!parts.length) {
    return data
  }

  parts.push(data.subarray(copied))
  return Buffer.concat(parts)
}

export function pixelFrameLayout (frame, av, columns, rows, pixelWidth, pixelHeight, options) {
  const cellWidth = pixelWidth / columns
  const cellHeight = pixelHeight / rows
  const gameRows = rows - (options.showStatus ? 1 : 0)

  if (gameRows < 1 || ![cellWidth, cellHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new VideoError('invalid terminal pixel geometry')
  }

  // Core pixels need not be square. Fit the core display aspect using the
  // measured terminal cell geometry, independently of the upload resolution.
  const coreAspect = Number.isFinite(av.aspectRatio) && av.aspectRatio > 0 ? av.aspectRatio : frame.width / frame.height
  const cellRatio = ((options.aspectRatio ?? coreAspect) * cellHeight) / cellWidth
  let width = columns
  let height = Math.max(1, Math.floor(width / cellRatio))

  if (height > gameRows) {
    height = gameRows
    width = Math.max(1, Math.floor(height * cellRatio))
  }

  // Upload scaling is integer-only and independent of the terminal's final cell placement.
  const scale = Math.min(
    options.scaling,
    Math.max(1, Math.floor(Math.min((width * cellWidth) / frame.width, (height * cellHeight) / frame.height)))
  )

  return {
    x: Math.floor((columns - width) / 2),
    y: Math.floor((gameRows - height) / 2),
    width,
    height,
    pixelWidth: frame.width * scale,
    pixelHeight: frame.height * scale,
    scale
  }
}

export function scaleFrame (frame, target, width, height, format = 'bgra') {
  const { data, pitch, pixelFormat } = frame
  const bytesPerPixel = pixelFormat === 1 ? 4 : 2

  if (
    ![0, 1, 2].includes(pixelFormat) ||
    pitch < frame.width * bytesPerPixel ||
    data.length < (frame.height - 1) * pitch + frame.width * bytesPerPixel ||
    target.length !== width * height * 4
  ) {
    throw new VideoError('invalid software frame or scaling buffer')
  }

  // Conversion and nearest-neighbor scaling share one pass and one reusable
  // output buffer. Source row padding is respected; X bits are not alpha.
  for (let y = 0; y < height; y++) {
    const sourceRow = Math.floor((y * frame.height) / height) * pitch

    for (let x = 0; x < width; x++) {
      const source = sourceRow + Math.floor((x * frame.width) / width) * bytesPerPixel
      const destination = (y * width + x) * 4

      if (pixelFormat === 1) {
        target[destination] = format === 'rgba' ? data[source + 2] : data[source]
        target[destination + 1] = data[source + 1]
        target[destination + 2] = format === 'rgba' ? data[source] : data[source + 2]
      } else {
        const pixel = data.readUInt16LE(source)
        const blue = pixel & 31
        const green = (pixel >> 5) & (pixelFormat === 2 ? 63 : 31)
        const red = (pixel >> (pixelFormat === 2 ? 11 : 10)) & 31

        target[destination] = format === 'rgba' ? (red << 3) | (red >> 2) : (blue << 3) | (blue >> 2)
        target[destination + 1] = pixelFormat === 2 ? (green << 2) | (green >> 4) : (green << 3) | (green >> 2)
        target[destination + 2] = format === 'rgba' ? (blue << 3) | (blue >> 2) : (red << 3) | (red >> 2)
      }

      target[destination + 3] = 255
    }
  }
}

// OpenTUI 0.5.11 / 6b9863e: NativeHandle=u32, lengths=u32, RGBA=[4]u16.
// These signatures intentionally do not support older pointer-based releases.
const signatures = {
  createRenderer: { arguments: ['uint32', 'uint32', 'uint8', 'uint8', 'pointer'], return: 'uint32' },
  destroyRenderer: { arguments: ['uint32', 'bool'], return: 'void' },
  setUseThread: { arguments: ['uint32', 'bool'], return: 'void' },
  setClearOnShutdown: { arguments: ['uint32', 'bool'], return: 'void' },
  setKittyKeyboardFlags: { arguments: ['uint32', 'uint8'], return: 'void' },
  setKittyImageTransport: { arguments: ['uint32', 'uint32'], return: 'uint32' },
  setupTerminal: { arguments: ['uint32', 'bool'], return: 'void' },
  processCapabilityResponse: { arguments: ['uint32', 'pointer', 'uint32'], return: 'void' },
  queryPixelResolution: { arguments: ['uint32'], return: 'void' },
  resizeRenderer: { arguments: ['uint32', 'uint32', 'uint32'], return: 'void' },
  getNextBuffer: { arguments: ['uint32'], return: 'uint32' },
  getBufferWidth: { arguments: ['uint32'], return: 'uint32' },
  getBufferHeight: { arguments: ['uint32'], return: 'uint32' },
  bufferClear: { arguments: ['uint32', 'pointer'], return: 'void' },
  bufferDrawText: {
    arguments: ['uint32', 'pointer', 'uint32', 'uint32', 'uint32', 'pointer', 'pointer', 'uint32'],
    return: 'void'
  },
  imageCreateFromRgba: { arguments: ['pointer', 'uint64', 'uint32', 'uint32', 'uint32', 'pointer'], return: 'uint32' },
  imageDestroy: { arguments: ['uint32'], return: 'void' },
  bufferDrawImage: { arguments: ['uint32', 'uint32', 'pointer'], return: 'uint8' },
  render: { arguments: ['uint32', 'bool'], return: 'uint8' },
  enableMouse: { arguments: ['uint32', 'bool'], return: 'void' },
  disableMouse: { arguments: ['uint32'], return: 'void' }
}

export class OpenTUI {
  #lib
  #functions
  #output
  #renderer = 0
  #options
  #columns = 0
  #rows = 0
  #resized = true
  #onResize
  #onData
  #raw
  #paused
  #inputStarted = false
  #failure
  #pixels = Buffer.alloc(0)
  #image = 0
  #retiredImages = []
  #black = Buffer.from([0, 0, 0, 0, 0, 0, 255, 0])
  #white = Buffer.from([255, 0, 255, 0, 255, 0, 255, 0])
  #status = ''
  #info = ''
  #lastStatus = ''
  #lastInfo = ''
  #nextPresentation = -Infinity
  #lastGeneration = -1
  #layoutKey = ''
  #pixelWidth = 0
  #pixelHeight = 0
  #pixelDeadline = Infinity
  #kittySupported = false
  #mouse = false
  #pixelMouse = false
  #frameWidth = 0
  #frameHeight = 0
  #closed = false
  #stats = { presented: 0, skipped: 0, resizes: 0, columns: 0, rows: 0, viewport: null, mouse: 'off' }

  constructor (options, callbacks) {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      throw new VideoError('OpenTUI requires a terminal on stdin and stdout')
    }

    this.#options = options
    this.#onResize = () => {
      this.#resized = true
    }

    this.#onData = data => {
      try {
        callbacks.onData(data)
      } catch (error) {
        this.#failure = error
        callbacks.onError(error)
      }
    }

    try {
      // SAFETY: Load the vendored release matching the u32-handle ABI above.
      const { lib } = dlopen(options.path)
      this.#lib = lib
      this.#functions = lib.getFunctions(signatures)

      if (options.fixIndexing) {
        this.#output = new VideoOutput(lib, fixVideoIndex)
      }

      // Create the renderer before taking over terminal input, so early failures leave stdin alone.
      if (!this.#resize()) {
        throw new VideoError('terminal dimensions are unavailable')
      }

      this.#raw = process.stdin.isRaw

      // A newly created stdin has readableFlowing=null, not isPaused()=true.
      // Restore that idle state as paused so it cannot keep Node alive at exit.
      this.#paused = process.stdin.readableFlowing !== true
      process.stdin.setRawMode(true)
      this.#inputStarted = true
      process.stdin.on('data', this.#onData)
      process.stdin.resume()
      process.stdout.on('resize', this.#onResize)

      // Node's stdout resize event ignores pixel-only changes to the same grid.
      process.on('SIGWINCH', this.#onResize)

      // Capability responses arrive asynchronously through the same stdin parser as keys.
      this.#call('setupTerminal', this.#renderer, 1)
      this.#call('queryPixelResolution', this.#renderer)
      this.#pixelDeadline = performance.now() + options.protocolTimeoutMs

      if (options.mouse) {
        // OpenTUI enables SGR cell reports with motion. Request pixel reports on top and
        // ask the terminal whether it accepted them: both report formats look the same.
        this.#call('enableMouse', this.#renderer, 1)
        writeSync(process.stdout.fd, '\x1b[?1016h\x1b[?1016$p')
        this.#mouse = true
        this.#stats.mouse = 'cells'
      }
    } catch (error) {
      this.close()
      throw new VideoError(error.message, { cause: error })
    }
  }

  #call (name, ...args) {
    try {
      // SAFETY: Handles belong to this live library. Buffers are retained through
      // each synchronous call; the native renderer never retains JS pixel storage.
      const result = this.#functions[name](...args)
      this.#output?.flush(name)
      return result
    } catch (error) {
      throw new VideoError(`${name}: ${error.message}`, { cause: error })
    }
  }

  #resize () {
    const columns = process.stdout.columns
    const rows = process.stdout.rows

    if (!columns || !rows) {
      return false
    }

    if (columns * rows > 250000) {
      throw new VideoError('terminal exceeds the supported 250000-cell surface')
    }

    if (!this.#renderer) {
      this.#renderer = this.#call('createRenderer', columns, rows, 0, 0, this.#output?.feed ?? null)

      if (!this.#renderer) {
        throw new VideoError('could not create the native renderer')
      }

      this.#call('setUseThread', this.#renderer, 0)
      this.#call('setClearOnShutdown', this.#renderer, 1)

      // Disambiguation + event types + alternate keys + all keys (1|2|4|8).
      // OpenTUI owns negotiation and pops its keyboard mode during teardown.
      this.#call('setKittyKeyboardFlags', this.#renderer, 15)
      this.#call('setKittyImageTransport', this.#renderer, this.#options.zlib ? 1 : 0)
    } else {
      if (columns !== this.#columns || rows !== this.#rows) {
        this.#call('resizeRenderer', this.#renderer, columns, rows)
      }

      // Font and DPI changes can alter pixel geometry even with the same grid.
      this.#pixelWidth = 0
      this.#pixelHeight = 0
      this.#pixelDeadline = performance.now() + this.#options.protocolTimeoutMs
      this.#call('queryPixelResolution', this.#renderer)
      this.#stats.resizes++
    }

    // Verify native buffer dimensions before publishing the new layout state.
    const buffer = this.#call('getNextBuffer', this.#renderer)

    if (this.#call('getBufferWidth', buffer) !== columns || this.#call('getBufferHeight', buffer) !== rows) {
      throw new VideoError('native renderer resize failed')
    }

    this.#columns = columns
    this.#rows = rows
    this.#stats.columns = columns
    this.#stats.rows = rows
    this.#resized = false
    this.#layoutKey = ''

    return true
  }

  render (frame, av, generation) {
    if (this.#failure) {
      throw this.#failure
    }

    if (this.#closed) {
      throw new VideoError('renderer is closed')
    }

    if (frame) {
      this.#frameWidth = frame.width
      this.#frameHeight = frame.height
    }

    if (this.#resized && !this.#resize()) {
      return
    }

    // Readiness and pacing gate both image uploads and status-only presentations.
    const now = performance.now()
    this.ready()

    if (now < this.#nextPresentation) {
      return
    }

    const gameRows = this.#rows - (this.#options.showStatus ? 1 : 0)
    let layout = null

    if (frame && gameRows > 0) {
      if (this.#pixelWidth > 0 && this.#pixelHeight > 0) {
        layout = pixelFrameLayout(
          frame,
          av,
          this.#columns,
          this.#rows,
          this.#pixelWidth,
          this.#pixelHeight,
          this.#options
        )
      }
    }

    // Skip only when frame generation, placement and both text rows are unchanged.
    const key = layout
      ? `${layout.x}:${layout.y}:${layout.width}:${layout.height}:${layout.pixelWidth ?? ''}:${layout.pixelHeight ?? ''}`
      : 'status-only'
    const changed = key !== this.#layoutKey

    if (
      !changed &&
      generation === this.#lastGeneration &&
      this.#lastStatus === this.#status &&
      this.#lastInfo === this.#info
    ) {
      return
    }

    const buffer = this.#call('getNextBuffer', this.#renderer)
    this.#call('bufferClear', buffer, this.#black)

    // Refresh native image identity while reusing the JavaScript conversion buffer.
    if (layout) {
      const pixelWidth = layout.pixelWidth
      const pixelHeight = layout.pixelHeight
      const size = pixelWidth * pixelHeight * 4

      if (this.#pixels.length !== size) {
        this.#pixels = Buffer.alloc(size)
      }

      scaleFrame(frame, this.#pixels, pixelWidth, pixelHeight, 'rgba')

      const previousImage = this.#image
      const handle = Buffer.alloc(4)
      const result = this.#call(
        'imageCreateFromRgba',
        this.#pixels,
        BigInt(size),
        pixelWidth,
        pixelHeight,
        pixelWidth * 4,
        handle
      )

      if (result !== 0) {
        throw new VideoError(`imageCreateFromRgba failed with status ${result}`)
      }

      this.#image = handle.readUInt32LE(0)

      if (!this.#image) {
        throw new VideoError('imageCreateFromRgba returned an invalid image handle')
      }

      // The previous handle remains live until the next frame has actually been presented.
      if (previousImage) {
        this.#retiredImages.push(previousImage)
      }

      // The ABI record separates terminal-cell placement from source-pixel dimensions.
      const imageOptions = Buffer.alloc(44)
      imageOptions.writeInt32LE(layout.x, 0)
      imageOptions.writeInt32LE(layout.y, 4)
      imageOptions.writeUInt32LE(layout.width, 8)
      imageOptions.writeUInt32LE(layout.height, 12)
      imageOptions.writeUInt32LE(pixelWidth, 16)
      imageOptions.writeUInt32LE(pixelHeight, 20)
      imageOptions.writeUInt32LE(0, 24)
      imageOptions.writeUInt32LE(0, 28)
      imageOptions.writeUInt32LE(pixelWidth, 32)
      imageOptions.writeUInt32LE(pixelHeight, 36)
      imageOptions.writeUInt32LE(0, 40)

      if (!this.#call('bufferDrawImage', buffer, this.#image, imageOptions)) {
        throw new VideoError(
          `bufferDrawImage failed (${layout.width}x${layout.height} cells, ${pixelWidth}x${pixelHeight} pixels, image ${this.#image})`
        )
      }
    }

    if (this.#options.showStatus) {
      // Keep error text to one cell per character and prevent terminal controls.
      const row = this.#rows - 1
      const status = this.#status.replace(/[^\x20-\x7e]/g, '?')
      const info = this.#info.replace(/[^\x20-\x7e]/g, '?')
      const statusText = Buffer.from(status.slice(0, Math.max(0, this.#columns - info.length - 1)))
      const infoText = Buffer.from(info.slice(0, this.#columns))
      this.#call('bufferDrawText', buffer, statusText, statusText.length, 0, row, this.#white, this.#black, 0)
      this.#call(
        'bufferDrawText',
        buffer,
        infoText,
        infoText.length,
        Math.max(0, this.#columns - infoText.length),
        row,
        this.#white,
        this.#black,
        0
      )
    }

    const status = this.#call('render', this.#renderer, changed ? 1 : 0)

    if (status === 2) {
      throw new VideoError('native presentation failed')
    }

    if (status === 1) {
      this.#stats.skipped++
      return
    }

    // Commit presentation state only after native rendering succeeds, not when it skips a frame.
    this.#layoutKey = key
    this.#lastGeneration = generation
    this.#lastStatus = this.#status
    this.#lastInfo = this.#info

    const period = 1000 / this.#options.maxFps
    this.#nextPresentation += period

    if (this.#nextPresentation <= now) {
      this.#nextPresentation = now + period
    }

    this.#stats.presented++
    this.#stats.viewport = layout

    // Successful presentation is the point at which old image handles can be destroyed.
    for (const image of this.#retiredImages) {
      this.#call('imageDestroy', image)
    }

    this.#retiredImages = []
  }

  summary () {
    if (this.#failure) {
      throw this.#failure
    }

    return { backend: 'opentui', ...this.#stats }
  }

  setStatus (text) {
    this.#status = text
  }

  locate (x, y) {
    // Map a 1-based terminal report, in cells or in pixels under SGR-Pixels, to frame pixels.
    const viewport = this.#stats.viewport

    if (!viewport || !this.#frameWidth || !this.#columns || !this.#rows || !this.#pixelWidth) {
      return null
    }

    const cellWidth = this.#pixelWidth / this.#columns
    const cellHeight = this.#pixelHeight / this.#rows
    const px = this.#pixelMouse ? x - 0.5 : (x - 0.5) * cellWidth
    const py = this.#pixelMouse ? y - 0.5 : (y - 0.5) * cellHeight
    const fx = (px - viewport.x * cellWidth) / (viewport.width * cellWidth)
    const fy = (py - viewport.y * cellHeight) / (viewport.height * cellHeight)

    return {
      x: Math.min(this.#frameWidth - 1, Math.max(0, Math.floor(fx * this.#frameWidth))),
      y: Math.min(this.#frameHeight - 1, Math.max(0, Math.floor(fy * this.#frameHeight))),
      inside: fx >= 0 && fx < 1 && fy >= 0 && fy < 1
    }
  }

  setInfo (text) {
    this.#info = text
  }

  ready () {
    if (this.#failure) {
      throw this.#failure
    }

    if (this.#resized) {
      this.#resize()
    }

    const ready = this.#kittySupported && this.#pixelWidth > 0 && this.#pixelHeight > 0

    if (!ready && performance.now() > this.#pixelDeadline) {
      throw new VideoError('terminal did not confirm Kitty Graphics and pixel resolution before the protocol timeout')
    }

    return ready
  }

  processResponse (data) {
    const text = data.toString('ascii')

    // OpenTUI 0.5.11 uses this image ID for the graphics capability probe.
    // eslint-disable-next-line no-control-regex
    if (/^\x1b_G(?:[^;]*,)?i=31337(?:,[^;]*)?;OK\x1b\\$/.test(text)) {
      this.#kittySupported = true
    }

    // The terminal reports height before width; retain only bounded positive dimensions.
    const prefix = `${String.fromCharCode(27)}[4;`
    if (text.startsWith(prefix) && text.endsWith('t')) {
      const dimensions = text.slice(prefix.length, -1).split(';').map(Number)

      if (
        dimensions.length === 2 &&
        dimensions.every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)
      ) {
        this.#pixelWidth = dimensions[1]
        this.#pixelHeight = dimensions[0]
        this.#layoutKey = ''
      }
    }

    // DECRQM reply for SGR-Pixels mouse reports: 1 and 3 mean the terminal set the mode.
    // eslint-disable-next-line no-control-regex
    const pixelMouse = /^\x1b\[\?1016;(\d)\$y$/.exec(text)

    if (pixelMouse && this.#mouse) {
      this.#pixelMouse = pixelMouse[1] === '1' || pixelMouse[1] === '3'
      this.#stats.mouse = this.#pixelMouse ? 'pixels' : 'cells'
    }

    // OpenTUI still owns all capability handling beyond the frontend's readiness checks.
    this.#call('processCapabilityResponse', this.#renderer, data, data.length)
  }

  close () {
    if (this.#closed) {
      return
    }

    this.#closed = true
    process.stdout.off('resize', this.#onResize)
    process.off('SIGWINCH', this.#onResize)

    // Release native rendering resources before restoring the terminal and closing the library.
    try {
      if (this.#renderer && this.#mouse) {
        // Stop mouse reports before the renderer leaves the alternate screen.
        this.#mouse = false
        writeSync(process.stdout.fd, '\x1b[?1016l')
        this.#call('disableMouse', this.#renderer)
      }

      if (this.#renderer) {
        this.#call('destroyRenderer', this.#renderer, 1)
        this.#renderer = 0
      }

      if (this.#image) {
        this.#call('imageDestroy', this.#image)
        this.#image = 0
      }

      for (const image of this.#retiredImages) {
        this.#call('imageDestroy', image)
      }

      this.#retiredImages = []
    } finally {
      try {
        if (this.#inputStarted) {
          try {
            // Restore the shell even if native teardown failed partway through.
            writeSync(process.stdout.fd, '\x1b[0m\x1b[?25h\x1b[?1049l')
          } finally {
            process.stdin.off('data', this.#onData)
            process.stdin.setRawMode(Boolean(this.#raw))

            if (this.#paused) {
              process.stdin.pause()
            }
          }
        }
      } finally {
        try {
          this.#output?.close()
        } finally {
          this.#lib?.close()
        }
      }
    }
  }
}
