#!/usr/bin/env -S node

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { inc, valid } from 'semver'
import { DependencyError } from '../errors.js'

if (existsSync('.env')) {
  process.loadEnvFile()
}

function getUserInfo () {
  const username = process.argv[3] ?? process.env.GITHUB_ACTOR
  const defaultUser = 'mcollina'

  const users = {
    mcollina: ['Matteo Collina', 'hello@matteocollina.com'],
    ShogunPanda: ['Paolo Insogna', 'paolo@cowtech.it']
  }

  let userInfo = users[username]

  if (!userInfo) {
    userInfo = users[defaultUser]
  }

  return userInfo
}

async function getVersion () {
  const requested = process.argv[2]

  if (!requested) {
    throw new DependencyError('A version or major/minor/patch increment is required')
  }

  // Increments use the current package version; explicit versions may include a tag prefix.
  if (['minor', 'major', 'patch'].includes(requested)) {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
    return inc(packageJson.version, requested)
  }

  return valid(requested.replace(/^v/, ''))
}

async function updatePackageJson (version) {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
  packageJson.version = version

  await writeFile('package.json', JSON.stringify(packageJson, null, 2) + '\n')
}

const userInfo = getUserInfo()
const version = await getVersion()

if (!version) {
  throw new DependencyError('Invalid release version')
}

await updatePackageJson(version)

// Release automation supplies an identity; local runs retain the developer's Git configuration.
if (process.env.GITHUB_ACTIONS === 'true') {
  // Repository-local identity avoids changing the runner's global Git settings.
  execFileSync('git', ['config', 'user.name', userInfo[0]])
  execFileSync('git', ['config', 'user.email', userInfo[1]])
}

// Stage only the version file, leaving unrelated tracked changes untouched.
execFileSync('git', ['add', '--', 'package.json'])
execFileSync('git', [
  'commit',
  '--only',
  '-m',
  `chore: Bumped v${version}.`,
  '-m',
  `Signed-off-by: ${userInfo[0]} <${userInfo[1]}>`,
  '--',
  'package.json'
])
