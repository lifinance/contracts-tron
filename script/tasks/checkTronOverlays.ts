/**
 * Checks that every Tron overlay survived an upstream sync (EXSC-858).
 *
 * Finds the overlays at `--before` (every `src/**` Solidity file with a `-tron`
 * version), then checks each one at `--after` against `--upstream`. Exits 1 on
 * any failed check unless `--accept-overlay-change` is set, in which case the
 * failures are printed as overridden.
 *
 * `--upstream` must be the upstream commit the sync merged, not the live
 * upstream tip: upstream moving on after the sync is not a fork problem. On a
 * committed merge that is `git merge-base <after> upstream/main`.
 *
 * Refs can be any tree-ish, including a tree SHA from `git write-tree`, so the
 * sync job can check a merge it has not committed.
 *
 * Usage:
 *   bunx tsx script/tasks/checkTronOverlays.ts \
 *     --before <ref> --after <ref> --upstream <ref> \
 *     [--accept-overlay-change] [--github-output <file>]
 */

import { execFileSync } from 'child_process'
import { appendFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { readBooleanFlag } from '../deploy/safe/cli-flags'

import {
  checkOverlays,
  isTronOverlay,
  touchedOverlays,
  type IOverlayFileState,
} from './tronOverlayGuard'

const SOURCE_DIR = 'src'
const MAX_BUFFER = 64 * 1024 * 1024

function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr =
      (error as { stderr?: string }).stderr?.trim() || String(error)
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
}

function resolveTree(ref: string): string {
  return git(['rev-parse', '--verify', `${ref}^{tree}`]).trim()
}

/** File contents at a tree, or null when the path is not in it. */
function readAtTree(tree: string, path: string): string | null {
  if (git(['ls-tree', tree, '--', path]).trim() === '') return null
  return git(['cat-file', 'blob', `${tree}:${path}`])
}

/**
 * Lists `src/**` Solidity files at a tree whose source mentions `-tron`.
 * A prefilter only: `isTronOverlay` decides. `git grep` exits 1 for "no
 * match", which is an answer, not an error.
 */
function listTronCandidates(tree: string): string[] {
  let output: string
  try {
    output = execFileSync(
      'git',
      ['grep', '-l', '-F', '-e', '-tron', tree, '--', `${SOURCE_DIR}/*.sol`],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(`git grep for overlays at ${tree} failed: ${stderr}`)
  }

  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(tree.length + 1))
}

function loadOverlayStates(
  before: string,
  after: string,
  upstream: string
): IOverlayFileState[] {
  const states: IOverlayFileState[] = []

  for (const path of listTronCandidates(before)) {
    const beforeSource = readAtTree(before, path)
    if (beforeSource === null)
      throw new Error(
        `${path} was listed at ${before} but cannot be read there`
      )
    if (!isTronOverlay(beforeSource)) continue

    states.push({
      path,
      beforeSource,
      afterSource: readAtTree(after, path),
      upstreamSource: readAtTree(upstream, path),
    })
  }

  return states
}

function writeGithubOutput(file: string, touched: string[]): void {
  appendFileSync(
    file,
    `touched=${touched.length > 0}\ntouched_paths=${touched.join(' ')}\n`
  )
}

const main = defineCommand({
  meta: {
    name: 'check-tron-overlays',
    description: 'Verify every Tron overlay survived an upstream sync',
  },
  args: {
    before: {
      type: 'string',
      description: 'Fork state before the sync (fork main before the merge)',
      required: true,
    },
    after: {
      type: 'string',
      description: 'Fork state after the sync (merge commit or merged tree)',
      required: true,
    },
    upstream: {
      type: 'string',
      description: 'The upstream commit the sync merged',
      required: true,
    },
    'accept-overlay-change': {
      type: 'boolean',
      description: 'Report failed checks as overridden and exit 0',
    },
    'github-output': {
      type: 'string',
      description:
        'Append touched=<bool> and touched_paths=<paths> to this file',
    },
  },
  run({ args }) {
    const accepted = readBooleanFlag(process.argv, {
      camel: 'acceptOverlayChange',
      kebab: 'accept-overlay-change',
    })
    const before = resolveTree(args.before)
    const after = resolveTree(args.after)
    const upstream = resolveTree(args.upstream)

    const states = loadOverlayStates(before, after, upstream)
    if (states.length === 0)
      throw new Error(
        `No Tron overlay found at ${args.before}. The fork always carries at least one; check that --before points at fork main.`
      )

    const touched = touchedOverlays(states)
    const findings = checkOverlays(states)

    consola.info(
      `Overlays at ${args.before}: ${states.map(({ path }) => path).join(', ')}`
    )
    consola.info(
      touched.length > 0
        ? `Changed by this sync: ${touched.join(', ')}`
        : 'No overlay changed by this sync'
    )

    if (args['github-output']) writeGithubOutput(args['github-output'], touched)

    if (findings.length === 0) {
      consola.success('Every Tron overlay survived the sync.')
      return
    }

    for (const { code, path, message } of findings) {
      const line = `[${code}] ${path} ${message}`
      if (accepted) consola.warn(`OVERRIDDEN ${line}`)
      else consola.error(line)
    }

    if (accepted) {
      consola.warn(
        `${findings.length} overlay check(s) overridden by --accept-overlay-change.`
      )
      return
    }

    consola.error(
      `${findings.length} overlay check(s) failed. See docs/TronFork.md. If the change is deliberate, add the tron-overlay-change-accepted label.`
    )
    process.exit(1)
  },
})

void runMain(main)
