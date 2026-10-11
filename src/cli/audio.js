import { SDLAudio } from '../audio.js'

export function listAudioDevices () {
  const audio = SDLAudio.open({})

  try {
    // SDL encodes its version as major * 1,000,000 + minor * 1,000 + patch.
    const version = `${Math.floor(audio.version / 1000000)}.${Math.floor(audio.version / 1000) % 1000}.${audio.version % 1000}`
    console.log(`SDL ${version}`)
    console.log(`Library: ${audio.path}`)
    console.log('\nAudio playback devices:')

    if (audio.devices.length === 0) {
      console.log('  No playback devices found.')
    } else {
      for (const device of audio.devices) {
        console.log(`  - ${device.name}`)
      }

      console.log('\nUse the exact device name in options.audio.device, or null for the system default.')
    }
  } finally {
    audio.close()
  }
}
