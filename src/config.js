import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { ConfigError } from './errors.js'
import { compileBindings, formatBinding } from './input.js'

export const packaged = isSea()
export const root = resolve(import.meta.dirname, '..')

export function assetPath (name) {
  // Node supplies the VFS mount through import.meta.dirname in the bundled ESM.
  return resolve(import.meta.dirname, packaged ? name : `../${name}`)
}

export function libraryPath (component) {
  const suffix = process.platform === 'darwin' ? 'dylib' : 'so'
  const filename = { video: 'libopentui', audio: 'libSDL3' }[component]
  return assetPath(`deps/${component}/${filename}.${suffix}`)
}

export const defaultBindings = {
  w: 'joypad:up',
  a: 'joypad:left',
  s: 'joypad:down',
  d: 'joypad:right',
  j: 'joypad:x',
  i: 'joypad:y',
  k: 'joypad:b',
  l: 'joypad:a',
  u: 'joypad:l',
  o: 'joypad:r',
  space: 'joypad:start',
  enter: 'joypad:select',
  q: 'loadState',
  e: 'saveState',
  z: 'previousSlot',
  x: 'nextSlot'
}

export const defaultConfig = {
  version: 1,
  paths: { system: './data/system', saves: 'saves', core: null, video: null, audio: null },
  options: {
    core: {},
    video: { maxFps: 60, scaling: 3, zlib: true, aspectRatio: null, fixIndexing: true },
    ui: { showStatus: true, protocolTimeoutMs: 2000 },
    audio: { enabled: true, device: null, volume: 1, latencyMs: 80, maxLatencyMs: 200, maxRateCorrection: 0.005 },
    save: { initialSlot: 1, module: null }
  },
  bindings: defaultBindings
}

export async function loadConfig (path) {
  try {
    const configPath = resolve(path ?? 'principe.json')
    const base = dirname(configPath)
    let parsed = {}

    try {
      parsed = JSON.parse(await readFile(configPath, 'utf8'))
    } catch (error) {
      // Only an absent implicit config falls back to defaults.
      if (path !== undefined || error.code !== 'ENOENT') {
        throw error
      }
    }

    // Clone nested defaults so one session cannot mutate another session's configuration.
    const defaults = structuredClone(defaultConfig)
    const config = {
      ...defaults,
      ...parsed,
      paths: { ...defaults.paths, ...parsed.paths },
      options: { ...defaults.options, ...parsed.options }
    }

    for (const group of Object.keys(defaults.options)) {
      config.options[group] = { ...defaults.options[group], ...parsed.options?.[group] }
    }

    // A supplied binding map is complete, not an overlay on the built-in shortcuts.
    const bindings = compileBindings(parsed.bindings === undefined ? defaults.bindings : parsed.bindings)
    config.bindings = Object.fromEntries([...bindings].map(([key, binding]) => [key, formatBinding(binding)]))

    if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
      throw new ConfigError(`unsupported platform ${process.platform}-${process.arch}`)
    }

    // Resolve user paths against the config, but keep native defaults tied to project assets.
    for (const key of ['system', 'saves']) {
      config.paths[key] = resolve(base, config.paths[key])
    }

    if (typeof config.paths.core !== 'string' || !config.paths.core.trim()) {
      throw new ConfigError('paths.core must specify an external libretro core library; no core is bundled')
    }

    config.paths.core = resolve(base, config.paths.core)

    for (const component of ['video', 'audio']) {
      config.paths[component] = config.paths[component]
        ? resolve(base, config.paths[component])
        : libraryPath(component)
    }

    if (config.options.save.module) {
      config.options.save.module = resolve(base, config.options.save.module)
    }

    return config
  } catch (error) {
    throw error.code === 'PRINCIPE_CONFIG' ? error : new ConfigError(error.message, { cause: error })
  }
}
