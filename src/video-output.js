import { toBuffer } from 'node:ffi'
import { writeSync } from 'node:fs'
import { VideoError } from './errors.js'

export class VideoOutput {
  #lib
  #functions
  #callback
  #state
  #spans = Buffer.alloc(24 * 64)
  #transform
  feed

  constructor (lib, transform) {
    this.#transform = transform

    // SAFETY: The pinned library implements NativeSpanFeed with 64-bit pointers
    // and 24-byte SpanInfo/Options records. No worker callbacks are enabled.
    // Borrow the renderer's library so SEA materialization cannot split native state.
    this.#lib = lib

    try {
      this.#functions = this.#lib.getFunctions({
        createNativeSpanFeed: { arguments: ['pointer'], return: 'pointer' },
        streamSetCallback: { arguments: ['pointer', 'pointer'], return: 'void' },
        attachNativeSpanFeed: { arguments: ['pointer'], return: 'int32' },
        streamDrainSpans: { arguments: ['pointer', 'pointer', 'uint32'], return: 'uint32' },
        destroyNativeSpanFeed: { arguments: ['pointer'], return: 'void' }
      })

      // Match the feed's queue and memory limits without enabling worker callbacks.
      const options = Buffer.alloc(24)
      options.writeUInt32LE(65536, 0)
      options.writeUInt32LE(2, 4)
      options.writeBigUInt64LE(32n * 1024n * 1024n, 8)
      options[17] = 1
      options.writeUInt32LE(512, 20)

      // SAFETY: The library consumes the options synchronously and returns an owned feed.
      this.feed = this.#functions.createNativeSpanFeed(options)

      if (!this.feed) {
        throw new VideoError('could not create native output feed')
      }

      // SAFETY: This synchronous callback and its trampoline outlive the attached feed.
      this.#callback = this.#lib.registerCallback(
        {
          arguments: ['uint64', 'uint32', 'uint64', 'uint64'],
          return: 'void'
        },
        (stream, event, pointer, size) => {
          if (event === 8) {
            // SAFETY: StateBuffer events replace the live feed-owned byte array.
            // The native producer and this synchronous consumer share chunk counts.
            this.#state = toBuffer(pointer, Number(size), false)
          }
        }
      )

      // SAFETY: Both the callback and feed belong to this still-live renderer library.
      this.#functions.streamSetCallback(this.feed, this.#callback)

      // SAFETY: Attachment transfers output to the initialized feed on the renderer's thread.
      if (this.#functions.attachNativeSpanFeed(this.feed) !== 0) {
        throw new VideoError('could not attach native output feed')
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  flush (operation) {
    const chunks = []
    let count

    // SAFETY: The live feed writes at most 64 ABI-sized span records into the retained buffer.
    while ((count = this.#functions.streamDrainSpans(this.feed, this.#spans, 64)) > 0) {
      for (let i = 0; i < count; i++) {
        const offset = i * 24
        const pointer = this.#spans.readBigUInt64LE(offset)
        const start = this.#spans.readUInt32LE(offset + 8)
        const length = this.#spans.readUInt32LE(offset + 12)
        const index = this.#spans.readUInt32LE(offset + 16)

        if (!this.#state || index >= this.#state.length || this.#state[index] === 0) {
          throw new VideoError('invalid native output span ownership')
        }

        // SAFETY: A drained span pins its native chunk until its count is
        // decremented. Copy all bytes before releasing that chunk to the producer.
        chunks.push(Buffer.from(toBuffer(pointer + BigInt(start), length, false)))
        this.#state[index]--
      }
    }

    if (!chunks.length) {
      return
    }

    const data = Buffer.concat(chunks)

    // Render frames are atomic in the native feed: do not filter partial spans.
    // Setup, replies and teardown are always forwarded byte-for-byte.
    const output = operation === 'render' ? this.#transform(data) : data

    // Synchronous writes may consume only part of a frame; keep writing until it is complete.
    let offset = 0

    while (offset < output.length) {
      offset += writeSync(process.stdout.fd, output, offset, output.length - offset)
    }
  }

  close () {
    if (this.feed) {
      // SAFETY: Detach the trampoline before destroying the live feed that could invoke it.
      this.#functions.streamSetCallback(this.feed, null)
      this.#functions.destroyNativeSpanFeed(this.feed)
      this.feed = null
      this.#state = null
    }

    if (this.#callback) {
      // SAFETY: The feed is already detached; the borrowed library is still live.
      this.#lib.unregisterCallback(this.#callback)
      this.#callback = null
    }
  }
}
