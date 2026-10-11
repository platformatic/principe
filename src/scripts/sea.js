#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'rolldown'
import { DependencyError } from '../errors.js'

function getPlatformConfig () {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new DependencyError(`Unsupported SEA platform: ${process.platform}`)
  }

  return {
    platform: process.platform,
    configPath: `src/sea/${process.platform === 'darwin' ? 'macos' : 'linux'}.json`
  }
}

function getArch () {
  if (!['arm64', 'x64'].includes(process.arch)) {
    throw new DependencyError(`Unsupported SEA architecture: ${process.arch}`)
  }

  return process.arch
}

async function run (command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })

    child.on('error', error => reject(new DependencyError(`${command}: ${error.message}`, { cause: error })))
    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new DependencyError(`${command} exited with code ${code}`))
      }
    })
  })
}

async function download (url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })

  if (!response.ok) {
    throw new DependencyError(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function getNodeBinary ({ platform, arch }) {
  const baseUrl = process.env.NODE_BUILD_BASE_URL

  if (!baseUrl) {
    return process.execPath
  }

  // An explicit Node build base must identify a version, not just a download host.
  const nodeBaseUrl = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const version = nodeBaseUrl.pathname.split('/').filter(Boolean).at(-1)

  if (!version || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new DependencyError(`Unable to determine Node version from NODE_BUILD_BASE_URL: ${baseUrl}`)
  }

  const nodeDirectory = join('tmp', `node-${platform}-${arch}`)
  const archiveName = `node-${version}-${platform}-${arch}`
  await rm(nodeDirectory, { force: true, recursive: true })
  await mkdir(nodeDirectory, { recursive: true })

  const archive = `${nodeDirectory}.tar.gz`
  const nodeBinary = join(nodeDirectory, 'bin', 'node')

  await download(new URL(`${archiveName}.tar.gz`, nodeBaseUrl).href, archive)
  await run('tar', ['-xzf', archive, '-C', nodeDirectory, '--strip-components', '1'])
  await chmod(nodeBinary, 0o755)

  return resolve(nodeBinary)
}

async function main () {
  const platform = getPlatformConfig()
  const arch = getArch()
  const config = JSON.parse(await readFile(platform.configPath, 'utf8'))

  // Validate native assets before replacing generated outputs or downloading Node.
  for (const path of Object.values(config.assets)) {
    if (!(await readFile(path)).length) {
      throw new DependencyError(`Empty SEA asset: ${path}`)
    }
  }

  await mkdir('dist', { recursive: true })
  await mkdir('tmp', { recursive: true })

  // Keep built-ins external so the embedded Node runtime supplies their implementations.
  await build({
    input: 'src/index.js',
    output: {
      file: config.main,
      format: 'esm'
    },
    external: id => id.startsWith('node:')
  })

  const nodeBinary = await getNodeBinary({ platform: platform.platform, arch })
  await writeFile('tmp/sea.json', JSON.stringify(config, null, 2) + '\n')
  await run(nodeBinary, ['--build-sea', 'tmp/sea.json'])

  if (process.platform === 'darwin') {
    // SEA changes the executable image; arm64 macOS requires a new signature.
    // Release notarization replaces this local ad-hoc signature later.
    await run('codesign', ['--force', '--sign', '-', config.output])
  }
}

try {
  await main()
} catch (error) {
  const failure = error.code === 'PRINCIPE_DEPENDENCY' ? error : new DependencyError(error.message, { cause: error })
  console.error(`${failure.code}: ${failure.message}`)
  process.exitCode = 1
}
