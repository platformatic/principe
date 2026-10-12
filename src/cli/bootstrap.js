import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defaultConfig } from '../config.js'
import { ConfigError, DependencyError, InputError } from '../errors.js'
import { captureInput, selectMouse } from './input.js'

const exec = promisify(execFile)
const cores = {
  snes9x: { name: 'Snes9x', filename: 'snes9x_libretro', description: 'SNES; non-commercial license' },
  dosbox: { name: 'DOSBox Pure', filename: 'dosbox_pure_libretro', description: 'DOS' }
}
const targets = {
  'darwin-arm64': 'apple/osx/arm64',
  'darwin-x64': 'apple/osx/x86_64',
  'linux-arm64': 'linux/aarch64',
  'linux-x64': 'linux/x86_64'
}

export async function bootstrap ({ core, config, noInput = false }) {
  if (core === undefined) {
    console.log('Recognized cores:')

    for (const [id, { name, description }] of Object.entries(cores)) {
      console.log(`  ${id} — ${name} (${description})`)
    }

    console.log('\nRun principe --bootstrap CORE [-c PATH] [-n | --no-input] to download and configure the core.')
    return
  }

  if (!Object.hasOwn(cores, core)) {
    throw new ConfigError(`unknown core ${core}; run principe --bootstrap to list recognized cores`)
  }

  const target = targets[`${process.platform}-${process.arch}`]

  if (!target) {
    throw new DependencyError(`Unsupported bootstrap host: ${process.platform}-${process.arch}`)
  }

  // Keep downloaded libraries and saves beside the selected configuration, not the executable.
  const path = resolve(config ?? 'principe.json')
  const root = dirname(path)
  const filename = `${cores[core].filename}.${process.platform === 'darwin' ? 'dylib' : 'so'}`
  const directory = resolve(root, 'cores')
  const destination = resolve(directory, filename)

  if (!noInput && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new InputError('bootstrap requires an interactive terminal supporting Kitty keyboard')
  }

  let staging

  try {
    // Stage the nightly on the destination filesystem so publication uses an atomic rename.
    await mkdir(directory, { recursive: true })
    staging = await mkdtemp(resolve(directory, `.${core}-`))
    const archive = resolve(staging, 'download.zip')
    const url = `https://buildbot.libretro.com/nightly/${target}/latest/${filename}.zip`
    console.log(`Downloading ${cores[core].name} for ${process.platform}-${process.arch}...`)

    const response = await fetch(url, { signal: AbortSignal.timeout(120000) })

    if (!response.ok) {
      throw new DependencyError(`${url}: HTTP ${response.status}`)
    }

    await writeFile(archive, Buffer.from(await response.arrayBuffer()))

    // Extract one entry to bytes, never allowing archive paths to control writes.
    const { stdout: binary } = await exec('unzip', ['-p', archive, filename], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024
    })

    if (!binary.length) {
      throw new DependencyError(`${cores[core].name} archive contains an empty library`)
    }

    const library = resolve(staging, filename)
    await writeFile(library, binary)

    // Replace the core only after its complete download and successful extraction.
    await rename(library, destination)
    console.log(`Core ready: ${destination}`)

    // Existing saves are preserved; bootstrap never cleans this directory.
    await mkdir(resolve(root, 'saves'), { recursive: true })

    // Cancellation leaves the previous config intact even though the core is already refreshed.
    const bindings = noInput ? structuredClone(defaultConfig.bindings) : await captureInput({ path })

    if (bindings === undefined) {
      console.log('The downloaded core remains available; the configuration and existing saves were not changed.')
      return
    }

    const mouse = await selectMouse()

    if (mouse === undefined) {
      console.log('The downloaded core remains available; the configuration and existing saves were not changed.')
      return
    }

    // Bootstrap resets configuration from defaults rather than merging the previous file.
    const settings = structuredClone(defaultConfig)
    settings.paths.core = `./cores/${filename}`
    settings.paths.saves = 'saves'
    settings.options.input.mouse = mouse
    settings.bindings = bindings
    const temporary = resolve(staging, 'principe.json')
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n')

    try {
      // Publish the complete configuration only after all input prompts finish.
      await rename(temporary, path)
    } catch (error) {
      throw new ConfigError(`cannot create configuration ${path}: ${error.message}`, { cause: error })
    }

    console.log(`\nBootstrap complete. Configuration saved to ${path}`)
  } catch (error) {
    if (['PRINCIPE_CONFIG', 'PRINCIPE_INPUT', 'PRINCIPE_DEPENDENCY'].includes(error.code)) {
      throw error
    }

    throw new DependencyError(`bootstrap: ${error.message}`, { cause: error })
  } finally {
    if (staging) {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
