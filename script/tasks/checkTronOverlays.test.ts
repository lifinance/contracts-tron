import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// eslint-disable-next-line import/no-unresolved
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  'checkTronOverlays.ts'
)
const OVERLAY = 'src/Libraries/LibAsset.sol'
const PLAIN = 'src/Facets/SomeFacet.sol'

const source = (version: string, body: string): string =>
  `/// @custom:version ${version}\nlibrary L {\n${body}\n}\n`

let repo: string

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function commit(files: Record<string, string | null>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      git('rm', '-q', path)
      continue
    }
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
    git('add', path)
  }
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

function run(...args: string[]): { status: number | null; output: string } {
  // consola drops info-level logs when NODE_ENV=test, which bun test sets
  const { NODE_ENV: _nodeEnv, TEST: _test, ...env } = process.env
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env,
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

let upstream: string
let before: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tron-overlays-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')

  upstream = commit(
    {
      [OVERLAY]: source('2.1.3', 'upstream();'),
      [PLAIN]: source('1.0.0', 'facet();'),
    },
    'upstream'
  )
  before = commit({ [OVERLAY]: source('2.1.3-tron', 'tron();') }, 'overlay')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('checkTronOverlays CLI', () => {
  it('passes when the sync left the overlay intact', () => {
    const after = commit({ [PLAIN]: source('1.0.1', 'facet2();') }, 'sync')
    const { status, output } = run(
      '--before',
      before,
      '--after',
      after,
      '--upstream',
      upstream
    )

    expect(output).toContain('No overlay changed by this sync')
    expect(status).toBe(0)
  })

  it('checks an uncommitted merge passed as a tree SHA', () => {
    writeFileSync(join(repo, OVERLAY), source('2.1.3', 'upstream();'))
    git('add', OVERLAY)
    const tree = git('write-tree')

    const { status, output } = run(
      '--before',
      before,
      '--after',
      tree,
      '--upstream',
      upstream
    )

    expect(output).toContain('OVERLAY_SUFFIX_LOST')
    expect(output).toContain('OVERLAY_DELTA_LOST')
    expect(status).toBe(1)
  })

  it('fails a deleted overlay and names the override label', () => {
    const after = commit({ [OVERLAY]: null }, 'delete')
    const { status, output } = run(
      '--before',
      before,
      '--after',
      after,
      '--upstream',
      upstream
    )

    expect(output).toContain('OVERLAY_DELETED')
    expect(output).toContain('tron-overlay-change-accepted')
    expect(status).toBe(1)
  })

  it('reports failures as overridden with --accept-overlay-change', () => {
    const after = commit({ [OVERLAY]: null }, 'delete')
    const { status, output } = run(
      '--before',
      before,
      '--after',
      after,
      '--upstream',
      upstream,
      '--accept-overlay-change'
    )

    expect(output).toContain('OVERRIDDEN [OVERLAY_DELETED]')
    expect(status).toBe(0)
  })

  it('refuses an override flag value it cannot read', () => {
    const after = commit({ [OVERLAY]: null }, 'delete')
    const { status, output } = run(
      '--before',
      before,
      '--after',
      after,
      '--upstream',
      upstream,
      '--accept-overlay-change=maybe'
    )

    expect(output).toContain("got 'maybe'")
    expect(status).not.toBe(0)
  })

  it('writes touched paths and the result to --github-output', () => {
    const after = commit(
      { [OVERLAY]: source('2.1.3-tron', 'tron2();') },
      'edit'
    )
    const outputFile = join(repo, 'github-output')
    const { status } = run(
      '--before',
      before,
      '--after',
      after,
      '--upstream',
      upstream,
      '--github-output',
      outputFile
    )

    expect(status).toBe(0)
    expect(readFileSync(outputFile, 'utf8')).toBe(
      `touched=true\ntouched_paths=${OVERLAY}\n`
    )
  })

  it('fails hard on a ref that does not resolve', () => {
    const { status, output } = run(
      '--before',
      before,
      '--after',
      'no-such-ref',
      '--upstream',
      upstream
    )

    expect(output).toContain('no-such-ref')
    expect(status).not.toBe(0)
  })

  it('fails when --before carries no overlay', () => {
    const { status, output } = run(
      '--before',
      upstream,
      '--after',
      before,
      '--upstream',
      upstream
    )

    expect(output).toContain('No Tron overlay found')
    expect(status).not.toBe(0)
  })
})
