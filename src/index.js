import { parseArgs } from 'node:util'
import { listAudioDevices } from './cli/audio.js'
import { bootstrap } from './cli/bootstrap.js'
import { configureInput } from './cli/input.js'
import { loadSession } from './core.js'
import { ConfigError } from './errors.js'

const usage =
  'Usage: principe ROM [-c PATH | --config PATH]\n       principe -h | --help\n       principe -a | --audio\n       principe (-i | --input) [-p | --probe] [-c PATH | --config PATH]\n       principe (-b | --bootstrap) [CORE] [-c PATH | --config PATH]'

export function parseCommandLine (args) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h' },
        audio: { type: 'boolean', short: 'a' },
        input: { type: 'boolean', short: 'i' },
        probe: { type: 'boolean', short: 'p' },
        bootstrap: { type: 'boolean', short: 'b' }
      }
    })

    // Validate mode combinations before dispatching commands that may write files.
    if (values.probe && !values.input) {
      throw new ConfigError('--probe requires --input')
    }

    if ([values.audio, values.input, values.bootstrap].filter(Boolean).length > 1) {
      throw new ConfigError('--audio, --input and --bootstrap cannot be combined')
    }

    // Bootstrap's positional argument identifies a core rather than game content.
    if (values.bootstrap && positionals.length > 1) {
      throw new ConfigError('--bootstrap accepts at most one core ID')
    }

    if (
      !values.help &&
      !values.audio &&
      !values.input &&
      !values.bootstrap &&
      (positionals.length !== 1 || !positionals[0])
    ) {
      throw new ConfigError(usage)
    }

    if (!values.audio && values.config === '') {
      throw new ConfigError('--config requires a non-empty path')
    }

    return {
      rom: values.bootstrap ? undefined : positionals[0],
      core: values.bootstrap ? positionals[0] : undefined,
      config: values.config,
      help: values.help ?? false,
      audio: values.audio ?? false,
      input: values.input ?? false,
      probe: values.probe ?? false,
      bootstrap: values.bootstrap ?? false
    }
  } catch (error) {
    if (error.code === 'PRINCIPE_CONFIG') {
      throw error
    }

    throw new ConfigError(error.message, { cause: error })
  }
}

export async function main (args = process.argv.slice(2)) {
  const { rom, core, config, help, audio, input, probe, bootstrap: bootstrapping } = parseCommandLine(args)

  // Utility modes return before loading a gameplay session or its native resources.
  if (help) {
    console.log(usage)
    return
  }

  if (audio) {
    listAudioDevices()
    return
  }

  if (input) {
    await configureInput({ config, probe })
    return
  }

  if (bootstrapping) {
    await bootstrap({ core, config })
    return
  }

  // Attach stop handlers only after there is a session for them to control.
  let session
  const stop = () => session?.stop()

  try {
    session = await loadSession(rom, config)
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    await session.run()
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await session?.close()
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    // Usage is CLI guidance, but genuine errors retain their diagnostic codes.
    console.error(
      error.code === 'PRINCIPE_CONFIG' && error.message === usage
        ? usage
        : `${error.code ?? 'PRINCIPE_RUNTIME'}: ${error.message}`
    )
    process.exitCode = 1
  }
}
