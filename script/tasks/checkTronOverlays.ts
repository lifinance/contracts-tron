/**
 * Checks that the Tron overlays survived an upstream sync (EXSC-858).
 *
 * Finds the overlays at `--before` (every `src/**` Solidity file with a `-tron`
 * version) and checks each one the sync reached. Exits 1 on any failed check
 * unless `--accept-overlay-change` is set, in which case the failures are
 * printed as overridden.
 *
 * The upstream side is derived, not passed: the commit the fork was synced to
 * is `merge-base(before, upstream)` and the one this change merges is
 * `merge-base(after, upstream)`. Comparing against the live upstream tip would
 * fail every time upstream moved on after a sync. When both are the same
 * commit the change brings in nothing from upstream and there is nothing to
 * check, so this can run on every PR.
 *
 * Usage:
 *   bunx tsx script/tasks/checkTronOverlays.ts \
 *     --before <commit> --after <commit> [--upstream upstream/main] \
 *     [--accept-overlay-change]
 */

import { execFileSync } from 'child_process'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { readBooleanFlag } from '../deploy/safe/cli-flags'

import {
  checkOverlays,
  isReachedBySync,
  isTronOverlay,
  type IOverlayFileState,
} from './tronOverlayGuard'

const SOURCE_DIR = 'src'
const MAX_BUFFER = 64 * 1024 * 1024 // 64 MiB

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

function resolveCommit(ref: string): string {
  return git(['rev-parse', '--verify', `${ref}^{commit}`]).trim()
}

function mergeBase(a: string, b: string): string {
  return git(['merge-base', a, b]).trim()
}

/** File contents at a commit, or null when the path is not in it. */
function readAt(commit: string, path: string): string | null {
  if (git(['ls-tree', commit, '--', path]).trim() === '') return null
  return git(['cat-file', 'blob', `${commit}:${path}`])
}

/**
 * Lists `src/**` Solidity files at a commit whose source mentions `-tron`.
 * A prefilter only: `isTronOverlay` decides. `git grep` exits 1 for "no
 * match", which is an answer, not an error.
 */
function listTronCandidates(commit: string): string[] {
  let output: string
  try {
    output = execFileSync(
      'git',
      ['grep', '-l', '-F', '-e', '-tron', commit, '--', `${SOURCE_DIR}/*.sol`],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    const stderr =
      (error as { stderr?: string }).stderr?.trim() || String(error)
    throw new Error(`git grep for overlays at ${commit} failed: ${stderr}`)
  }

  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(commit.length + 1))
}

interface IRefs {
  before: string
  after: string
  previousUpstream: string
  upstream: string
}

function loadOverlayStates(refs: IRefs): IOverlayFileState[] {
  const states: IOverlayFileState[] = []

  for (const path of listTronCandidates(refs.before)) {
    const beforeSource = readAt(refs.before, path)
    if (beforeSource === null)
      throw new Error(
        `${path} was listed at ${refs.before} but cannot be read there`
      )
    if (!isTronOverlay(beforeSource)) continue

    states.push({
      path,
      beforeSource,
      afterSource: readAt(refs.after, path),
      previousUpstreamSource: readAt(refs.previousUpstream, path),
      upstreamSource: readAt(refs.upstream, path),
    })
  }

  return states
}

const main = defineCommand({
  meta: {
    name: 'check-tron-overlays',
    description: 'Verify the Tron overlays survived an upstream sync',
  },
  args: {
    before: {
      type: 'string',
      description: 'Fork main before the change (PR base)',
      required: true,
    },
    after: {
      type: 'string',
      description: 'Fork state after the change (PR merge commit)',
      required: true,
    },
    upstream: {
      type: 'string',
      description: 'Ref for lifinance/contracts main',
      default: 'upstream/main',
    },
    'accept-overlay-change': {
      type: 'boolean',
      description: 'Report failed checks as overridden and exit 0',
    },
  },
  run({ args }) {
    const accepted = readBooleanFlag(process.argv, {
      camel: 'acceptOverlayChange',
      kebab: 'accept-overlay-change',
    })
    const before = resolveCommit(args.before)
    const after = resolveCommit(args.after)
    const upstreamTip = resolveCommit(args.upstream)
    const refs: IRefs = {
      before,
      after,
      previousUpstream: mergeBase(before, upstreamTip),
      upstream: mergeBase(after, upstreamTip),
    }

    if (refs.previousUpstream === refs.upstream) {
      consola.info(
        `${args.after} merges no new upstream commits (both sides at ${refs.upstream}); nothing to check.`
      )
      return
    }

    consola.info(
      `Sync from upstream ${refs.previousUpstream} to ${refs.upstream}`
    )

    const states = loadOverlayStates(refs)
    if (states.length === 0) {
      consola.info(`No Tron overlay at ${args.before}; nothing to check.`)
      return
    }

    const reached = states.filter(isReachedBySync).map(({ path }) => path)
    consola.info(
      `Overlays: ${states
        .map(({ path }) => path)
        .join(', ')}. Reached by this sync: ${
        reached.length > 0 ? reached.join(', ') : 'none'
      }`
    )

    const findings = checkOverlays(states)
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
