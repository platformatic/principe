export class ConfigError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'ConfigError'
    this.code = 'PRINCIPE_CONFIG'
  }
}

export class NativeError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'NativeError'
    this.code = 'PRINCIPE_NATIVE'
  }
}

export class VideoError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'VideoError'
    this.code = 'PRINCIPE_VIDEO'
  }
}

export class InputError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'InputError'
    this.code = 'PRINCIPE_INPUT'
  }
}

export class AudioError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'AudioError'
    this.code = 'PRINCIPE_AUDIO'
  }
}

export class StateError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'StateError'
    this.code = 'PRINCIPE_STATE'
  }
}

export class PersistenceError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'PersistenceError'
    this.code = 'PRINCIPE_PERSISTENCE'
  }
}

export class DependencyError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'DependencyError'
    this.code = 'PRINCIPE_DEPENDENCY'
  }
}
