/**
 * Rule engine for the Tron overlay check (EXSC-858).
 *
 * An overlay is a Solidity file the fork deliberately keeps different from
 * upstream, marked by a `-tron` version (`2.1.3-tron`, `2.1.3-tron-r2`). An
 * upstream sync must not silently undo one: this module decides, for each
 * overlay the fork carried before the sync, whether it survived the merge.
 * `checkTronOverlays.ts` resolves the file contents from git; this module does
 * no I/O.
 */

import { readContractVersion } from '../deploy/shared/contract-version'

export type OverlayViolationCode =
  | 'OVERLAY_DELETED'
  | 'OVERLAY_SUFFIX_LOST'
  | 'OVERLAY_DELTA_LOST'
  | 'OVERLAY_BASE_STALE'
  | 'OVERLAY_UPSTREAM_MISSING'

/** One overlay file at the three points the check compares. */
export interface IOverlayFileState {
  path: string
  /** Source on the fork before the sync. */
  beforeSource: string
  /** Source after the sync; null when the merge removed the file. */
  afterSource: string | null
  /** Source at the upstream commit the sync merged; null when absent there. */
  upstreamSource: string | null
}

export interface IOverlayFinding {
  path: string
  code: OverlayViolationCode
  message: string
}

const TRON_SUFFIX_RE = /^-tron(?:-r\d+)?$/

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
 * Drops comments, pragma and blank lines, the same filter
 * `versionControlAndAuditCheck.yml` applies, so "the code differs" means the
 * same thing here as it does to the audit gate. This also drops the
 * `@custom:version` line.
 */
function significantLines(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('//') &&
        !line.startsWith('/*') &&
        !line.startsWith('*') &&
        !line.startsWith('pragma')
    )
    .join('\n')
}

/**
 * Whether two sources differ in code, ignoring comments, pragma and whitespace.
 *
 * @param a - One source.
 * @param b - The other source.
 * @returns True when the executable content differs.
 */
export function hasCodeDifference(a: string, b: string): boolean {
  return significantLines(a) !== significantLines(b)
}

function describeVersion(source: string): string {
  const read = readContractVersion(source)
  if (read.kind === 'ok') return `"${read.version}"`
  if (read.kind === 'malformed') return `malformed "${read.raw}"`
  return 'no @custom:version tag'
}

function checkOverlay(file: IOverlayFileState): IOverlayFinding[] {
  const { path, beforeSource, afterSource, upstreamSource } = file
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

  if (!hasCodeDifference(upstreamSource, afterSource))
    findings.push({
      path,
      code: 'OVERLAY_DELTA_LOST',
      message: `now has the same code as upstream, so the Tron change is gone. Restore it from the fork's previous version.`,
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
 * Checks every overlay the fork carried before a sync.
 *
 * @param files - One entry per overlay; callers select them with `isTronOverlay`
 *   on the pre-sync source.
 * @returns One finding per failed check, in input order; empty when all pass.
 */
export function checkOverlays(files: IOverlayFileState[]): IOverlayFinding[] {
  return files.flatMap(checkOverlay)
}

/**
 * The overlays whose content the sync changed.
 *
 * @param files - Overlay states, as passed to `checkOverlays`.
 * @returns Paths whose post-sync source differs from the pre-sync source.
 */
export function touchedOverlays(files: IOverlayFileState[]): string[] {
  return files
    .filter(({ beforeSource, afterSource }) => beforeSource !== afterSource)
    .map(({ path }) => path)
}
