import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// eslint-disable-next-line import/no-unresolved
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { withholdCredentials } from '../deploy/safe/spawn-env'

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  'checkTronOverlays.ts'
)
const OVERLAY = 'src/Libraries/LibAsset.sol'
const PLAIN = 'src/Facets/SomeFacet.sol'

const source = (version: string, lines: string[]): string =>
  [`/// @custom:version ${version}`, 'library L {', ...lines, '}', ''].join(
    '\n'
  )

const UPSTREAM_V1 = source('2.1.3', ['upstream();'])
const UPSTREAM_V2 = source('2.2.0', ['upstream();', 'upstreamFix();'])
const OVERLAY_V1 = source('2.1.3-tron', ['tronBypass();', 'upstream();'])
const OVERLAY_V2 = source('2.2.0-tron', [
  'tronBypass();',
  'upstream();',
  'upstreamFix();',
])

let repo: string
let forkBase: string
let upstreamTip: string

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function stage(files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      git('rm', '-q', path)
      continue
    }
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
    git('add', path)
  }
}

function commit(files: Record<string, string | null>, message: string): string {
  stage(files)
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

/** A sync merge of the upstream tip into the fork, resolved to `files`. */
function syncMerge(
  files: Record<string, string | null>,
  base: string = forkBase
): string {
  git('checkout', '-q', base)
  stage(files)
  const tree = git('write-tree')
  return git('commit-tree', tree, '-p', base, '-p', upstreamTip, '-m', 'sync')
}

function run(...args: string[]): { status: number | null; output: string } {
  // consola drops info-level logs when NODE_ENV=test, which bun test sets
  const {
    NODE_ENV: _nodeEnv,
    TEST: _test,
    ...env
  } = process.env as Record<string, string>
  withholdCredentials(env)
  const result = spawnSync(
    process.execPath,
    [CLI, '--upstream', 'upstream', ...args],
    { cwd: repo, encoding: 'utf8', env }
  )
  return { status: result.status, output: result.stdout + result.stderr }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tron-overlays-'))
  git('init', '-q', '-b', 'upstream')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')

  const upstreamBase = commit(
    { [OVERLAY]: UPSTREAM_V1, [PLAIN]: source('1.0.0', ['facet();']) },
    'upstream v1'
  )
  upstreamTip = commit({ [OVERLAY]: UPSTREAM_V2 }, 'upstream v2')

  git('checkout', '-q', '-b', 'main', upstreamBase)
  forkBase = commit({ [OVERLAY]: OVERLAY_V1 }, 'overlay')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('checkTronOverlays CLI', () => {
  it('passes a sync that rebased the overlay correctly', () => {
    const after = syncMerge({ [OVERLAY]: OVERLAY_V2 })
    const { status, output } = run('--before', forkBase, '--after', after)

    expect(output).toContain(`Reached by this sync: ${OVERLAY}`)
    expect(output).toContain('Every Tron overlay survived the sync.')
    expect(status).toBe(0)
  })

  it('fails a sync that took upstream wholesale and names the label', () => {
    const after = syncMerge({ [OVERLAY]: UPSTREAM_V2 })
    const { status, output } = run('--before', forkBase, '--after', after)

    expect(output).toContain('OVERLAY_SUFFIX_LOST')
    expect(output).toContain('OVERLAY_DELTA_LOST')
    expect(output).toContain('tronBypass();')
    expect(output).toContain('tron-overlay-change-accepted')
    expect(status).toBe(1)
  })

  it('reports failures as overridden with --accept-overlay-change', () => {
    const after = syncMerge({ [OVERLAY]: null })
    const { status, output } = run(
      '--before',
      forkBase,
      '--after',
      after,
      '--accept-overlay-change'
    )

    expect(output).toContain('OVERRIDDEN [OVERLAY_DELETED]')
    expect(status).toBe(0)
  })

  it('refuses an override flag value it cannot read', () => {
    const after = syncMerge({ [OVERLAY]: null })
    const { status, output } = run(
      '--before',
      forkBase,
      '--after',
      after,
      '--accept-overlay-change=maybe'
    )

    expect(output).toContain("got 'maybe'")
    expect(status).not.toBe(0)
  })

  it('does not check a change that merges no upstream commits', () => {
    git('checkout', '-q', forkBase)
    const after = commit({ [OVERLAY]: null }, 'ordinary fork change')
    const { status, output } = run('--before', forkBase, '--after', after)

    expect(output).toContain('merges no new upstream commits')
    expect(status).toBe(0)
  })

  it('passes with a note when the fork carries no overlay', () => {
    git('checkout', '-q', forkBase)
    const noOverlay = commit({ [OVERLAY]: UPSTREAM_V1 }, 'retire overlay')
    const after = syncMerge({ [OVERLAY]: UPSTREAM_V2 }, noOverlay)
    const { status, output } = run('--before', noOverlay, '--after', after)

    expect(output).toContain('No Tron overlay')
    expect(status).toBe(0)
  })

  it('fails hard on a ref that does not resolve', () => {
    const { status, output } = run(
      '--before',
      forkBase,
      '--after',
      'no-such-ref'
    )

    expect(output).toContain('no-such-ref')
    expect(status).not.toBe(0)
  })
})
