/**
 * CI guard that verifies the `contracts-tron` overlay survived a change intact.
 *
 * Run it on every fork PR and on the merge result of the weekly upstream sync
 * before anything lands on `main`. It resolves each `src/**\/*.sol` file at three
 * refs (fork base, fork head, `upstream/main`), hands them to the rule engine in
 * `tronForkDelta.ts`, and exits non-zero on any violation.
 *
 * Usage: `bunx tsx script/tasks/checkTronForkDelta.ts --base <ref> --head <ref>`
 */
import { execFileSync } from 'child_process'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  checkForkDelta,
  type IForkDeltaFileState,
  type ITronAuditLog,
} from './tronForkDelta'

const AUDIT_LOG_PATH = 'audit/auditLog.json'
const SOURCE_DIR = 'src'

function git(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, // 64 MB — the whole src/ tree is read through this
  })
}

/** Returns file contents at a ref, or null when the path does not exist there. */
function readAtRef(ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], // a missing path is expected, not an error
    })
  } catch {
    return null
  }
}

/** Lists Solidity sources under `src/` at a ref; empty when the ref has none. */
function listSolidityFiles(ref: string): string[] {
  try {
    return git(['ls-tree', '-r', '--name-only', ref, '--', SOURCE_DIR])
      .split('\n')
      .filter((path) => path.endsWith('.sol'))
  } catch {
    return []
  }
}

function loadAuditLog(ref: string): ITronAuditLog {
  const raw = readAtRef(ref, AUDIT_LOG_PATH)

  if (raw === null) {
    consola.warn(`${AUDIT_LOG_PATH} not found at ${ref}; treating it as empty`)
    return {}
  }

  return JSON.parse(raw) as ITronAuditLog
}

const main = defineCommand({
  meta: {
    name: 'check-tron-fork-delta',
    description:
      'Verify the Tron overlay is intact, correctly versioned and audited after a merge or PR',
  },
  args: {
    base: {
      type: 'string',
      description: 'Fork state before the change (PR base or pre-merge main)',
      default: 'origin/main',
    },
    head: {
      type: 'string',
      description: 'Fork state after the change (PR head or the merge commit)',
      default: 'HEAD',
    },
    upstream: {
      type: 'string',
      description: 'Upstream ref to compare against',
      default: 'upstream/main',
    },
  },
  run({ args }) {
    const { base, head, upstream } = args

    const paths = [
      ...new Set([
        ...listSolidityFiles(base),
        ...listSolidityFiles(head),
        ...listSolidityFiles(upstream),
      ]),
    ].sort()

    if (paths.length === 0) {
      consola.error(
        `No Solidity sources found under ${SOURCE_DIR}/ at any of ${base}, ${head}, ${upstream} — are all three refs fetched?`
      )
      process.exit(1)
    }

    const files: IForkDeltaFileState[] = paths.map((path) => ({
      path,
      baseSource: readAtRef(base, path),
      headSource: readAtRef(head, path),
      upstreamSource: readAtRef(upstream, path),
    }))

    const findings = checkForkDelta(files, loadAuditLog(head))

    consola.info(
      `Checked ${files.length} Solidity sources (base=${base}, head=${head}, upstream=${upstream})`
    )

    if (findings.length === 0) {
      consola.success(
        'Tron fork delta is intact, correctly versioned and audited.'
      )
      return
    }

    for (const finding of findings)
      consola.error(`[${finding.code}] ${finding.path} ${finding.message}`)

    consola.error(
      `${findings.length} fork-delta violation(s). See docs/TronFork.md, section "The fork-delta guard".`
    )
    process.exit(1)
  },
})

void runMain(main)
