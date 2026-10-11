import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dlopen } from 'node:ffi'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DependencyError } from '../errors.js'

if (existsSync('.env')) {
  process.loadEnvFile()
}

const exec = promisify(execFile)
const deps = resolve(import.meta.dirname, '../../deps')
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const currentTarget = `${process.platform}-${process.arch}`

// Downloaded renderer binaries use a fixed revision; cores are supplied externally.
const openTUIVersion = '0.5.11'

function step (message) {
  console.log(`\x1b[35;1m--> ${message}\x1b[0m`)
}

function info (message) {
  console.log(`\x1b[36m${message}\x1b[0m`)
}

async function run (command, args) {
  try {
    const { stdout } = await exec(command, args, { maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    throw new DependencyError(`${command}: ${error.message}`, { cause: error })
  }
}

async function metadata (url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })

  if (!response.ok) {
    throw new DependencyError(`${url}: HTTP ${response.status}`)
  }

  return response.json()
}

async function download (url, path) {
  info(`Downloading ${basename(path)}...`)

  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })

  if (!response.ok) {
    throw new DependencyError(`${url}: HTTP ${response.status}`)
  }

  const data = Buffer.from(await response.arrayBuffer())
  await writeFile(path, data)
  return data
}

async function localSDL () {
  const libdir = await run('pkg-config', ['--variable=libdir', 'sdl3'])
  const filename = process.platform === 'darwin' ? 'libSDL3.dylib' : 'libSDL3.so'
  const source = await realpath(resolve(libdir, process.platform === 'darwin' ? filename : 'libSDL3.so.0'))

  // SAFETY: SDL3 exposes SDL_GetVersion as int(void) on the host architecture.
  const { lib, functions } = dlopen(source, { SDL_GetVersion: { arguments: [], return: 'int32' } })

  try {
    // SAFETY: The resolved function matches SDL3's version ABI.
    const version = functions.SDL_GetVersion()

    if (version < 3002000 || version >= 4000000) {
      throw new DependencyError('SDL 3.2 or later in the 3.x series is required')
    }

    return { source, filename, version }
  } finally {
    lib.close()
  }
}

async function preflight () {
  step('Checking local prerequisites')

  try {
    for (const command of ['pkg-config', 'tar']) {
      await run('which', [command])
    }

    await run('pkg-config', ['--exists', 'sdl3'])
    return await localSDL()
  } catch (error) {
    console.error('\x1b[33mInstall the prerequisites manually, then run this command again. See README.md.\x1b[0m')
    console.error(
      process.platform === 'darwin'
        ? '  brew install pkg-config sdl3'
        : '  Install SDL3 (3.2+) and its pkg-config metadata using your distribution package manager.'
    )
    throw new DependencyError(error.message, { cause: error })
  }
}

async function install (name, action) {
  step(name)
  const temporary = await mkdtemp(resolve(deps, `.${name}-`))
  const destination = resolve(deps, name)
  const backup = `${temporary}.previous`
  let replaced = false

  try {
    await action(temporary)

    // Preserve the old component until its prepared replacement is installed.
    try {
      await rename(destination, backup)
      replaced = true
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }

    // Publish on the same filesystem, restoring the previous component if publication fails.
    try {
      await rename(temporary, destination)
    } catch (error) {
      if (replaced) {
        await rename(backup, destination)
      }

      throw error
    }

    await rm(backup, { recursive: true, force: true })
    info(`Ready: deps/${name}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function importSDL (directory, libraries) {
  for (const { source, filename, version } of libraries) {
    info(`Importing ${source} (${version})...`)
    const bytes = await readFile(source)
    await writeFile(resolve(directory, filename), bytes)
  }
}

async function installAudio (libraries) {
  await install('audio', async directory => {
    await importSDL(directory, libraries)
  })
}

async function installVideo (target) {
  await install('video', async directory => {
    const data = await metadata(`https://registry.npmjs.org/@opentui/core-${target}/${openTUIVersion}`)
    const path = resolve(directory, 'package.tgz')
    const bytes = await download(data.dist.tarball, path)

    // Verify npm's integrity metadata before extracting executable native code.
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== data.dist.integrity) {
      throw new DependencyError('OpenTUI archive integrity mismatch')
    }

    const filename = target.startsWith('darwin-') ? 'libopentui.dylib' : 'libopentui.so'
    await run('tar', ['-xzf', path, '-C', directory, '--strip-components=1', `package/${filename}`])
    await rm(path)
  })
}

async function main () {
  const target = process.argv[2] ?? currentTarget

  if (!targets.includes(target)) {
    throw new DependencyError(`Unsupported video target: ${target}`)
  }

  if (!targets.includes(currentTarget)) {
    throw new DependencyError(`Unsupported host: ${currentTarget}`)
  }

  // Validate local prerequisites before touching any managed dependency directory.
  const sdl = await preflight()
  await mkdir(deps, { recursive: true })

  await installAudio([sdl])
  await installVideo(target)

  info('All dependencies are ready.')
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const failure = error.code === 'PRINCIPE_DEPENDENCY' ? error : new DependencyError(error.message, { cause: error })
    console.error(`\x1b[31m${failure.code}: ${failure.message}\x1b[0m`)
    process.exitCode = 1
  }
}
