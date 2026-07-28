/**
 * Pure rule engine for the `contracts-tron` fork-delta guard.
 *
 * Import this from anything that needs to answer "is the Tron overlay still
 * intact, correctly versioned and audited?" — the CLI wrapper
 * (`checkTronForkDelta.ts`) supplies the git-resolved file states; this module
 * owns the rules and stays free of I/O so it can be tested directly.
 */

/** Distinct violation kinds the guard can report. */
export type ForkDeltaViolationCode =
  | 'TRON_FILE_DELETED'
  | 'VERSION_TAG_MISSING'
  | 'TRON_SUFFIX_LOST'
  | 'TRON_BASELINE_STALE'
  | 'TRON_DELTA_MISSING'
  | 'TRON_VERSION_NOT_BUMPED'
  | 'TRON_AUDIT_MISSING'
  | 'UNDECLARED_FORK_DELTA'
  | 'UPSTREAM_TRON_LEAK'

/** One Solidity file seen at three points: fork base, fork head, upstream. */
export interface IForkDeltaFileState {
  /** Repo-relative path, e.g. `src/Libraries/LibAsset.sol`. */
  path: string
  /** Source on the fork before the change (merge base / PR base); null if absent. */
  baseSource: string | null
  /** Source after the change (merge result / PR head); null if absent. */
  headSource: string | null
  /** Source on `upstream/main`; null if the file does not exist upstream. */
  upstreamSource: string | null
}

export interface IForkDeltaFinding {
  path: string
  code: ForkDeltaViolationCode
  message: string
}

/** The subset of `audit/auditLog.json` this guard reads. */
export interface ITronAuditLog {
  auditedContracts?: Record<string, Record<string, string[]>>
}

/** `2.1.3-tron` and `2.1.3-tron-r2` are both valid overlay versions. */
const TRON_VERSION_PATTERN = /^(\d+\.\d+\.\d+)-tron(?:-r\d+)?$/
const VERSION_TAG_PATTERN = /^\/\/\/ @custom:version (\S+)/m

/**
 * Reads the `@custom:version` tag from Solidity source.
 *
 * @param source - Full file contents.
 * @returns The version string, or null when the file carries no version tag.
 */
export function parseVersionTag(source: string): string | null {
  return VERSION_TAG_PATTERN.exec(source)?.[1] ?? null
}

/**
 * Extracts the upstream baseline a `-tron` version is pinned to.
 *
 * @param version - A version string such as `2.1.3-tron-r2`.
 * @returns The baseline (`2.1.3`), or null when this is not a `-tron` version.
 */
export function parseTronBaseline(version: string): string | null {
  return TRON_VERSION_PATTERN.exec(version)?.[1] ?? null
}

/**
 * Strips everything the audit process treats as non-substantive: comments,
 * pragma lines and blank lines. Mirrors the filter in
 * `versionControlAndAuditCheck.yml` so the two never disagree about whether a
 * change was audit-relevant. Note this also removes the `@custom:version` line,
 * so a version bump alone is not a relevant change.
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
 * Whether two revisions of a file differ in audit-relevant ways.
 *
 * @param before - Earlier source.
 * @param after - Later source.
 * @returns True when the executable content differs, ignoring comments,
 *          pragma and whitespace.
 */
export function hasRelevantChanges(before: string, after: string): boolean {
  return significantLines(before) !== significantLines(after)
}

function contractName(path: string): string {
  return (
    path
      .split('/')
      .pop()
      ?.replace(/\.sol$/, '') ?? path
  )
}

function hasAuditEntry(
  auditLog: ITronAuditLog,
  path: string,
  version: string
): boolean {
  const entries = auditLog.auditedContracts?.[contractName(path)]?.[version]

  return Array.isArray(entries) && entries.length > 0
}

/**
 * Applies the fork-delta rules to a set of files.
 *
 * Two invariants are enforced. For every file that carried a `-tron` version on
 * the fork before the change, the overlay must survive the change: the suffix
 * stays, the baseline tracks upstream's current version, the delta is still
 * present, and any version change (including a tag-only rebase) or
 * audit-relevant edit bumps the version and lands an audit entry. For every
 * other file, divergence from upstream must be declared by carrying a `-tron`
 * version — and that new version must also be audited — so the overlay cannot
 * grow silently.
 *
 * @param files - File states to evaluate.
 * @param auditLog - Parsed `audit/auditLog.json`.
 * @returns One finding per violation, in input order; empty when compliant.
 */
export function checkForkDelta(
  files: IForkDeltaFileState[],
  auditLog: ITronAuditLog
): IForkDeltaFinding[] {
  const findings: IForkDeltaFinding[] = []

  const report = (
    path: string,
    code: ForkDeltaViolationCode,
    message: string
  ): void => {
    findings.push({ path, code, message })
  }

  for (const { path, baseSource, headSource, upstreamSource } of files) {
    const baseVersion = baseSource ? parseVersionTag(baseSource) : null
    const wasTronOverlay =
      baseVersion !== null && parseTronBaseline(baseVersion) !== null

    if (!wasTronOverlay) {
      if (headSource === null) continue

      const headVersion = parseVersionTag(headSource)
      const isDeclared =
        headVersion !== null && parseTronBaseline(headVersion) !== null
      const divergesFromUpstream =
        upstreamSource === null ||
        hasRelevantChanges(upstreamSource, headSource)

      if (divergesFromUpstream && !isDeclared) {
        report(
          path,
          'UNDECLARED_FORK_DELTA',
          `differs from upstream but carries version "${
            headVersion ?? 'none'
          }". Declare the overlay by tagging it "<upstream-version>-tron", or drop the divergence.`
        )
        continue
      }

      // Newly declared overlay: the suffix alone is not enough — every -tron
      // version needs its own audit entry (same rule as a rebased existing one).
      if (
        isDeclared &&
        headVersion !== null &&
        !hasAuditEntry(auditLog, path, headVersion)
      )
        report(
          path,
          'TRON_AUDIT_MISSING',
          `declares the tron overlay at "${headVersion}", but audit/auditLog.json has no entry for that version.`
        )

      continue
    }

    if (headSource === null) {
      report(
        path,
        'TRON_FILE_DELETED',
        `carried the tron overlay ("${baseVersion}") on the fork but is gone after this change.`
      )
      continue
    }

    const headVersion = parseVersionTag(headSource)

    if (headVersion === null) {
      report(
        path,
        'VERSION_TAG_MISSING',
        'carries the tron overlay but has no @custom:version tag after this change.'
      )
      continue
    }

    const headBaseline = parseTronBaseline(headVersion)

    if (headBaseline === null) {
      report(
        path,
        'TRON_SUFFIX_LOST',
        `was "${baseVersion}" and is now "${headVersion}" — the "-tron" suffix was dropped while the overlay is still present. Restore it (a conflict resolution must keep our suffix, not take upstream's version line).`
      )
      continue
    }

    const upstreamVersion = upstreamSource
      ? parseVersionTag(upstreamSource)
      : null

    // upstream must never carry the overlay suffix; if it does, the two repos
    // have crossed and no baseline suggestion we could make would be meaningful
    if (
      upstreamVersion !== null &&
      parseTronBaseline(upstreamVersion) !== null
    ) {
      report(
        path,
        'UPSTREAM_TRON_LEAK',
        `is "${headVersion}" and upstream is "${upstreamVersion}" — upstream must never carry a "-tron" version. A fork-only change was pushed to lifinance/contracts; revert it there before syncing.`
      )
      continue
    }

    if (upstreamVersion !== null && headBaseline !== upstreamVersion) {
      report(
        path,
        'TRON_BASELINE_STALE',
        `is "${headVersion}" but upstream is now at "${upstreamVersion}". Rebase the overlay version to "${upstreamVersion}-tron" so one version still maps to one bytecode.`
      )
      continue
    }

    if (
      upstreamSource !== null &&
      !hasRelevantChanges(upstreamSource, headSource)
    ) {
      report(
        path,
        'TRON_DELTA_MISSING',
        `is tagged "${headVersion}" but is now equivalent to upstream — the customization was lost, or it is obsolete and should be retired deliberately.`
      )
      continue
    }

    const relevant = hasRelevantChanges(baseSource ?? '', headSource)

    // Comment/pragma/whitespace-only edits that leave the version alone are
    // ignored — same filter as versionControlAndAuditCheck.yml. A version
    // change alone still requires an audit entry: rebasing `2.1.3-tron` →
    // `2.2.0-tron` is a new version even when significantLines() sees no diff
    // (the @custom:version line is stripped by that filter).
    if (!relevant && headVersion === baseVersion) continue

    if (relevant && headVersion === baseVersion) {
      report(
        path,
        'TRON_VERSION_NOT_BUMPED',
        `changed in an audit-relevant way but the version stayed "${headVersion}".`
      )
      continue
    }

    if (!hasAuditEntry(auditLog, path, headVersion))
      report(
        path,
        'TRON_AUDIT_MISSING',
        `changed and moved to "${headVersion}", but audit/auditLog.json has no entry for that version. Re-review the overlay against the new upstream code and log it.`
      )
  }

  return findings
}
