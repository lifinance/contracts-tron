/**
 * Rule engine for the Tron overlay check (EXSC-858).
 *
 * An overlay is a Solidity file the fork deliberately keeps different from
 * upstream, marked by a `-tron` version (`2.1.3-tron`, `2.1.3-tron-r2`). An
 * upstream sync must not silently undo one: this module decides, for each
 * overlay the sync reached, whether it survived the merge.
 * `checkTronOverlays.ts` resolves the file contents from git; this module does
 * no I/O.
 */

import { isAuditNonRelevantLine } from '../deploy/audit/audit-relevant-source'
import { readContractVersion } from '../deploy/shared/contract-version'

export type OverlayViolationCode =
  | 'OVERLAY_DELETED'
  | 'OVERLAY_SUFFIX_LOST'
  | 'OVERLAY_DELTA_LOST'
  | 'OVERLAY_BASE_STALE'
  | 'OVERLAY_UPSTREAM_MISSING'

/** One overlay file at the four points the check compares. */
export interface IOverlayFileState {
  path: string
  /** Source on the fork before the sync. */
  beforeSource: string
  /** Source after the sync; null when the merge removed the file. */
  afterSource: string | null
  /** Source at the upstream commit the fork was synced to before; null when absent. */
  previousUpstreamSource: string | null
  /** Source at the upstream commit the sync merged; null when absent there. */
  upstreamSource: string | null
}

export interface IOverlayFinding {
  path: string
  code: OverlayViolationCode
  message: string
}

const TRON_SUFFIX_RE = /^-tron(?:-r\d+)?$/
const MAX_LISTED_LINES = 5

/**
 * Whether a version marks a Tron overlay.
 *
 * @param version - A version string as read by `readContractVersion`.
 * @param base - The `MAJOR.MINOR.PATCH` prefix of that version.
 * @returns True for `2.1.3-tron` and `2.1.3-tron-r2`, false otherwise.
 */
export function isTronVersion(version: string, base: string): boolean {
  return TRON_SUFFIX_RE.test(version.slice(base.length))
}

/**
 * Whether a source file carries a Tron overlay version.
 *
 * @param source - Solidity source text.
 * @returns True when its `@custom:version` is a `-tron` version.
 */
export function isTronOverlay(source: string): boolean {
  const read = readContractVersion(source)
  return read.kind === 'ok' && isTronVersion(read.version, read.base)
}

/**
 * The lines the audit gate treats as code (`isAuditNonRelevantLine`), trimmed,
 * minus block-comment continuation lines, which the gate keeps. The
 * `@custom:version` line is a comment, so it is dropped too.
 */
function significantLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isAuditNonRelevantLine(line) && !line.startsWith('*'))
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}

/**
 * The code lines the fork added on top of its upstream base that the merged
 * file no longer carries on top of the new upstream.
 *
 * Counted per line, not as a set: the fork's bypass adds generic lines such as
 * `return;` and `}` that upstream has elsewhere, so a line "survived" only if
 * the merged file has as many more copies than the new upstream as the fork
 * had more than the old one.
 *
 * @param base - Upstream source the overlay was built on; '' when absent.
 * @param overlay - The fork's source before the sync.
 * @param upstream - Upstream source the sync merged.
 * @param merged - The fork's source after the sync.
 * @returns Each missing line once per missing copy, in `overlay` order.
 */
export function missingForkLines(
  base: string,
  overlay: string,
  upstream: string,
  merged: string
): string[] {
  const inBase = countLines(significantLines(base))
  const inOverlay = countLines(significantLines(overlay))
  const inUpstream = countLines(significantLines(upstream))
  const inMerged = countLines(significantLines(merged))
  const missing: string[] = []

  for (const [line, overlayCount] of inOverlay) {
    const added = overlayCount - (inBase.get(line) ?? 0)
    const carried = (inMerged.get(line) ?? 0) - (inUpstream.get(line) ?? 0)
    for (let i = Math.max(carried, 0); i < added; i++) missing.push(line)
  }

  return missing
}

function describeVersion(source: string): string {
  const read = readContractVersion(source)
  if (read.kind === 'ok') return `"${read.version}"`
  if (read.kind === 'malformed') return `malformed "${read.raw}"`
  return 'no @custom:version tag'
}

function listLines(lines: string[]): string {
  const shown = lines.slice(0, MAX_LISTED_LINES).map((line) => `\n    ${line}`)
  const more = lines.length - MAX_LISTED_LINES
  return shown.join('') + (more > 0 ? `\n    ...and ${more} more` : '')
}

function checkOverlay(file: IOverlayFileState): IOverlayFinding[] {
  const { path, beforeSource, afterSource, previousUpstreamSource } = file
  const { upstreamSource } = file
  const before = describeVersion(beforeSource)

  if (afterSource === null)
    return [
      {
        path,
        code: 'OVERLAY_DELETED',
        message: `was a Tron overlay (${before}) and the sync removed it.`,
      },
    ]

  if (upstreamSource === null)
    return [
      {
        path,
        code: 'OVERLAY_UPSTREAM_MISSING',
        message: `is a Tron overlay but the merged upstream commit no longer has this file. Re-home or retire the overlay deliberately.`,
      },
    ]

  const findings: IOverlayFinding[] = []
  const after = readContractVersion(afterSource)
  const upstream = readContractVersion(upstreamSource)

  if (after.kind !== 'ok' || !isTronVersion(after.version, after.base))
    findings.push({
      path,
      code: 'OVERLAY_SUFFIX_LOST',
      message: `was ${before} and is now ${describeVersion(
        afterSource
      )}. Keep the "-tron" suffix when resolving the version line.`,
    })

  const missing = missingForkLines(
    previousUpstreamSource ?? '',
    beforeSource,
    upstreamSource,
    afterSource
  )
  if (missing.length > 0)
    findings.push({
      path,
      code: 'OVERLAY_DELTA_LOST',
      message: `lost ${missing.length} line(s) of the Tron change:${listLines(
        missing
      )}\n  Restore them. If upstream's new code means they must change, rewrite them and add the tron-overlay-change-accepted label.`,
    })

  const upstreamVersion = upstream.kind === 'ok' ? upstream.version : null
  if (after.kind === 'ok' && after.base !== upstreamVersion)
    findings.push({
      path,
      code: 'OVERLAY_BASE_STALE',
      message: `is "${after.version}" but upstream is ${describeVersion(
        upstreamSource
      )}. Rebase the overlay onto upstream's code and version it "<upstream-version>-tron".`,
    })

  return findings
}

/**
 * Whether the sync reached an overlay: the fork's copy changed, or upstream's
 * did. The second case matters on its own — a resolution that keeps the
 * fork's file untouched while upstream moved on leaves the overlay stale.
 *
 * @param file - One overlay's state.
 * @returns True when the overlay needs checking for this sync.
 */
export function isReachedBySync(file: IOverlayFileState): boolean {
  return (
    file.beforeSource !== file.afterSource ||
    file.previousUpstreamSource !== file.upstreamSource
  )
}

/**
 * Checks the overlays a sync reached. Overlays the sync did not reach are
 * skipped, so a state accepted on an earlier sync is not re-flagged until
 * upstream changes that file again.
 *
 * @param files - One entry per overlay the fork carried before the sync;
 *   callers select them with `isTronOverlay` on the pre-sync source.
 * @returns One finding per failed check, in input order; empty when all pass.
 */
export function checkOverlays(files: IOverlayFileState[]): IOverlayFinding[] {
  return files.filter(isReachedBySync).flatMap(checkOverlay)
}
