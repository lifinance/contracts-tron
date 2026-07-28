import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  checkForkDelta,
  hasRelevantChanges,
  parseVersionTag,
  parseTronBaseline,
  type IForkDeltaFileState,
  type ITronAuditLog,
} from './tronForkDelta'

const AUDIT_LOG: ITronAuditLog = {
  auditedContracts: {
    LibAsset: {
      '2.1.3': ['audit20251007'],
      '2.1.3-tron': ['audit20260522'],
      '2.2.0': ['audit20260801'],
      '2.2.0-tron': ['audit20260815'],
    },
  },
}

/** Builds a minimal Solidity source carrying a version tag and one statement. */
const solidity = (version: string, body = 'uint256 x = 1;'): string =>
  [
    '// SPDX-License-Identifier: LGPL-3.0-only',
    'pragma solidity ^0.8.17;',
    '',
    `/// @custom:version ${version}`,
    'library LibAsset {',
    `    ${body}`,
    '}',
  ].join('\n')

const UPSTREAM = solidity('2.1.3')
const FORK = solidity(
  '2.1.3-tron',
  'uint256 x = 1; // tron bypass\n    uint256 y = 2;'
)

const file = (
  overrides: Partial<IForkDeltaFileState> = {}
): IForkDeltaFileState => ({
  path: 'src/Libraries/LibAsset.sol',
  baseSource: FORK,
  headSource: FORK,
  upstreamSource: UPSTREAM,
  ...overrides,
})

const codes = (files: IForkDeltaFileState[]): string[] =>
  checkForkDelta(files, AUDIT_LOG).map((finding) => finding.code)

describe('parseVersionTag', () => {
  it('extracts a plain semver version', () => {
    expect(parseVersionTag(solidity('2.1.3'))).toBe('2.1.3')
  })

  it('extracts a -tron suffixed version', () => {
    expect(parseVersionTag(solidity('2.1.3-tron'))).toBe('2.1.3-tron')
  })

  it('extracts a -tron revision version', () => {
    expect(parseVersionTag(solidity('2.1.3-tron-r2'))).toBe('2.1.3-tron-r2')
  })

  it('returns null when no version tag is present', () => {
    expect(parseVersionTag('pragma solidity ^0.8.17;')).toBeNull()
  })

  it('ignores a version tag that is not at the start of a line', () => {
    expect(
      parseVersionTag('contract A { /// @custom:version 1.0.0 }')
    ).toBeNull()
  })
})

describe('parseTronBaseline', () => {
  it('returns the baseline of a -tron version', () => {
    expect(parseTronBaseline('2.1.3-tron')).toBe('2.1.3')
  })

  it('returns the baseline of a -tron revision version', () => {
    expect(parseTronBaseline('2.1.3-tron-r3')).toBe('2.1.3')
  })

  it('returns null for a plain semver version', () => {
    expect(parseTronBaseline('2.1.3')).toBeNull()
  })

  it('returns null for an unrelated suffix', () => {
    expect(parseTronBaseline('2.1.3-beta')).toBeNull()
  })
})

describe('hasRelevantChanges', () => {
  it('is false for identical sources', () => {
    expect(hasRelevantChanges(UPSTREAM, UPSTREAM)).toBe(false)
  })

  it('is false when only comments differ', () => {
    expect(
      hasRelevantChanges(UPSTREAM, `${UPSTREAM}\n// an added comment`)
    ).toBe(false)
  })

  it('is false when only the version tag differs', () => {
    expect(hasRelevantChanges(solidity('2.1.3'), solidity('2.2.0'))).toBe(false)
  })

  it('is false when only blank lines differ', () => {
    expect(hasRelevantChanges(UPSTREAM, `${UPSTREAM}\n\n   \n`)).toBe(false)
  })

  it('is false when only the pragma differs', () => {
    expect(
      hasRelevantChanges(UPSTREAM, UPSTREAM.replace('^0.8.17', '^0.8.20'))
    ).toBe(false)
  })

  it('is true when a code line differs', () => {
    expect(
      hasRelevantChanges(UPSTREAM, solidity('2.1.3', 'uint256 x = 2;'))
    ).toBe(true)
  })
})

describe('checkForkDelta', () => {
  it('reports nothing for an untouched, correctly versioned tron file', () => {
    expect(checkForkDelta([file()], AUDIT_LOG)).toEqual([])
  })

  it('reports nothing for an upstream file with no fork divergence', () => {
    expect(
      checkForkDelta(
        [
          file({
            path: 'src/Facets/AllBridgeFacet.sol',
            baseSource: UPSTREAM,
            headSource: UPSTREAM,
            upstreamSource: UPSTREAM,
          }),
        ],
        AUDIT_LOG
      )
    ).toEqual([])
  })

  it('flags a tron file deleted by the merge', () => {
    expect(codes([file({ headSource: null })])).toEqual(['TRON_FILE_DELETED'])
  })

  it('flags a tron file whose version tag disappeared', () => {
    expect(codes([file({ headSource: 'pragma solidity ^0.8.17;' })])).toEqual([
      'VERSION_TAG_MISSING',
    ])
  })

  it('flags a resolution that dropped the -tron suffix', () => {
    const resolved = FORK.replace('2.1.3-tron', '2.2.0')

    expect(
      codes([file({ headSource: resolved, upstreamSource: solidity('2.2.0') })])
    ).toEqual(['TRON_SUFFIX_LOST'])
  })

  it('flags a -tron baseline left behind after upstream bumped the version', () => {
    expect(codes([file({ upstreamSource: solidity('2.2.0') })])).toEqual([
      'TRON_BASELINE_STALE',
    ])
  })

  it('accepts a -tron baseline rebased onto the new upstream version', () => {
    const rebased = FORK.replace('2.1.3-tron', '2.2.0-tron')

    expect(
      checkForkDelta(
        [
          file({
            headSource: rebased,
            upstreamSource: solidity('2.2.0'),
          }),
        ],
        AUDIT_LOG
      )
    ).toEqual([])
  })

  it('accepts a -tron revision suffix on a matching baseline', () => {
    const revised = FORK.replace('2.1.3-tron', '2.1.3-tron-r2')

    expect(
      codes([file({ headSource: revised })]).filter(
        (code) => code === 'TRON_BASELINE_STALE'
      )
    ).toEqual([])
  })

  it('flags a -tron version that leaked into upstream instead of suggesting "-tron-tron"', () => {
    const findings = checkForkDelta(
      [file({ upstreamSource: solidity('2.1.3-tron') })],
      AUDIT_LOG
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'UPSTREAM_TRON_LEAK',
    ])
    expect(findings[0]?.message).not.toContain('-tron-tron')
  })

  it('flags a tron file that has become identical to upstream', () => {
    expect(
      codes([
        file({
          headSource: solidity('2.1.3-tron'),
        }),
      ])
    ).toEqual(['TRON_DELTA_MISSING'])
  })

  it('flags relevant merge changes that did not bump the -tron version', () => {
    const changed = FORK.replace('uint256 y = 2;', 'uint256 y = 3;')

    expect(codes([file({ headSource: changed })])).toEqual([
      'TRON_VERSION_NOT_BUMPED',
    ])
  })

  it('flags a bumped -tron version with no audit-log entry', () => {
    const upstreamNext = solidity('2.3.0')
    const forkNext = solidity(
      '2.3.0-tron',
      'uint256 x = 1; // tron bypass\n    uint256 y = 9;'
    )

    expect(
      codes([file({ headSource: forkNext, upstreamSource: upstreamNext })])
    ).toEqual(['TRON_AUDIT_MISSING'])
  })

  it('accepts a bumped -tron version that has an audit-log entry', () => {
    const forkNext = solidity(
      '2.2.0-tron',
      'uint256 x = 1; // tron bypass\n    uint256 y = 9;'
    )

    expect(
      checkForkDelta(
        [file({ headSource: forkNext, upstreamSource: solidity('2.2.0') })],
        AUDIT_LOG
      )
    ).toEqual([])
  })

  it('ignores comment-only merge changes to a tron file', () => {
    expect(
      checkForkDelta(
        [file({ headSource: `${FORK}\n// note added upstream` })],
        AUDIT_LOG
      )
    ).toEqual([])
  })

  it('flags fork divergence on a file that carries no -tron suffix', () => {
    expect(
      codes([
        file({
          path: 'src/Facets/AllBridgeFacet.sol',
          baseSource: solidity('2.1.3'),
          headSource: solidity('2.1.3', 'uint256 x = 42;'),
          upstreamSource: UPSTREAM,
        }),
      ])
    ).toEqual(['UNDECLARED_FORK_DELTA'])
  })

  it('flags a fork-only contract that carries no -tron suffix', () => {
    expect(
      codes([
        file({
          path: 'src/Facets/TronOnlyFacet.sol',
          baseSource: null,
          headSource: solidity('1.0.0'),
          upstreamSource: null,
        }),
      ])
    ).toEqual(['UNDECLARED_FORK_DELTA'])
  })

  it('accepts a fork-only contract that carries a -tron suffix and an audit', () => {
    expect(
      codes([
        file({
          path: 'src/Libraries/LibAsset.sol',
          baseSource: null,
          headSource: solidity('2.1.3-tron'),
          upstreamSource: null,
        }),
      ])
    ).toEqual([])
  })

  it('ignores a file deleted in both the fork and upstream', () => {
    expect(
      checkForkDelta(
        [
          file({
            path: 'src/Facets/RemovedFacet.sol',
            baseSource: null,
            headSource: null,
            upstreamSource: null,
          }),
        ],
        AUDIT_LOG
      )
    ).toEqual([])
  })

  it('reports findings for every offending file', () => {
    expect(
      codes([
        file({ headSource: null }),
        file({
          path: 'src/Facets/AllBridgeFacet.sol',
          baseSource: solidity('2.1.3'),
          headSource: solidity('2.1.3', 'uint256 x = 42;'),
          upstreamSource: UPSTREAM,
        }),
      ])
    ).toEqual(['TRON_FILE_DELETED', 'UNDECLARED_FORK_DELTA'])
  })

  it('includes the offending path and a remediation hint in each finding', () => {
    const [finding] = checkForkDelta(
      [file({ upstreamSource: solidity('2.2.0') })],
      AUDIT_LOG
    )

    expect(finding?.path).toBe('src/Libraries/LibAsset.sol')
    expect(finding?.message).toContain('2.2.0-tron')
  })

  it('treats a missing auditedContracts section as no audits on record', () => {
    const forkNext = solidity(
      '2.2.0-tron',
      'uint256 x = 1; // tron bypass\n    uint256 y = 9;'
    )

    expect(
      checkForkDelta(
        [file({ headSource: forkNext, upstreamSource: solidity('2.2.0') })],
        {}
      ).map((finding) => finding.code)
    ).toEqual(['TRON_AUDIT_MISSING'])
  })

  it('treats an empty audit-id array as no audits on record', () => {
    const forkNext = solidity(
      '2.2.0-tron',
      'uint256 x = 1; // tron bypass\n    uint256 y = 9;'
    )

    expect(
      checkForkDelta(
        [file({ headSource: forkNext, upstreamSource: solidity('2.2.0') })],
        {
          auditedContracts: { LibAsset: { '2.2.0-tron': [] } },
        }
      ).map((finding) => finding.code)
    ).toEqual(['TRON_AUDIT_MISSING'])
  })
})
