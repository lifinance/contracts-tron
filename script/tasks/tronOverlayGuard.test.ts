// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  checkOverlays,
  isReachedBySync,
  isTronOverlay,
  missingForkLines,
  type IOverlayFileState,
} from './tronOverlayGuard'

const PATH = 'src/Libraries/LibAsset.sol'

const source = (version: string, body: string[]): string =>
  [
    '// SPDX-License-Identifier: LGPL-3.0-only',
    'pragma solidity ^0.8.17;',
    '',
    '/// @title LibAsset',
    `/// @custom:version ${version}`,
    'library LibAsset {',
    ...body,
    '}',
    '',
  ].join('\n')

const UPSTREAM_BODY = [
  '  function transfer() internal {',
  '    token.transfer();',
  '  }',
]
const UPSTREAM_BODY_V2 = [
  '  function transfer() internal {',
  '    token.transfer();',
  '    emit Sent();',
  '  }',
]
const TRON_CONSTANT = '  address constant TRON_USDT = address(0xa614);'
const TRON_BYPASS = '    if (token == TRON_USDT) return tronTransfer();'

const withTron = (body: string[]): string[] => [
  TRON_CONSTANT,
  body[0] ?? '',
  TRON_BYPASS,
  ...body.slice(1),
]

const upstreamV1 = source('2.1.3', UPSTREAM_BODY)
const upstreamV2 = source('2.2.0', UPSTREAM_BODY_V2)
const overlayV1 = source('2.1.3-tron', withTron(UPSTREAM_BODY))
const overlayV2 = source('2.2.0-tron', withTron(UPSTREAM_BODY_V2))

/** A sync from upstream 2.1.3 to 2.2.0, resolved correctly unless overridden. */
const state = (overrides: Partial<IOverlayFileState>): IOverlayFileState => ({
  path: PATH,
  beforeSource: overlayV1,
  afterSource: overlayV2,
  previousUpstreamSource: upstreamV1,
  upstreamSource: upstreamV2,
  ...overrides,
})

const codes = (files: IOverlayFileState[]): string[] =>
  checkOverlays(files).map(({ code }) => code)

describe('isTronOverlay', () => {
  it.each([
    ['2.1.3-tron', true],
    ['2.1.3-tron-r2', true],
    ['2.1.3', false],
    ['2.1.3-tronx', false],
    ['2.1.3-zksync', false],
    ['2.1.3-tron-r', false],
  ])('%s -> %p', (version, expected) => {
    expect(isTronOverlay(source(version, UPSTREAM_BODY))).toBe(expected)
  })

  it('is false for a file without a version tag', () => {
    expect(isTronOverlay('library X {}')).toBe(false)
  })
})

describe('missingForkLines', () => {
  it('is empty when every added line survived', () => {
    expect(
      missingForkLines(upstreamV1, overlayV1, upstreamV2, overlayV2)
    ).toEqual([])
  })

  it('lists added lines the merge dropped', () => {
    expect(
      missingForkLines(upstreamV1, overlayV1, upstreamV2, upstreamV2)
    ).toEqual([TRON_CONSTANT.trim(), TRON_BYPASS.trim()])
  })

  it('does not count upstream copies of a generic line the fork added', () => {
    const base = source('2.1.3', ['a();', 'return;'])
    const overlay = source('2.1.3-tron', ['a();', 'return;', 'return;'])

    expect(missingForkLines(base, overlay, base, base)).toEqual(['return;'])
  })

  it('allows upstream to change lines the fork did not add', () => {
    const base = source('2.1.3', ['old();'])
    const overlay = source('2.1.3-tron', ['old();', 'tron();'])
    const upstream = source('2.2.0', ['new();'])
    const merged = source('2.2.0-tron', ['new();', 'tron();'])

    expect(missingForkLines(base, overlay, upstream, merged)).toEqual([])
  })

  it('ignores comments, pragma, whitespace and the version line', () => {
    const reformatted = [
      'pragma solidity 0.8.29;',
      '/// @custom:version 9.9.9',
      '/* a block',
      ' * comment */',
      'library LibAsset {',
      ...withTron(UPSTREAM_BODY).map((line) => `   ${line.trim()}   `),
      '}',
    ].join('\n')

    expect(
      missingForkLines(upstreamV1, overlayV1, upstreamV1, reformatted)
    ).toEqual([])
  })

  it('does not treat a reworded block comment the fork added as lost', () => {
    const overlay = source('2.1.3-tron', [
      '  /**',
      '   * Tron USDT never returns true.',
      '   */',
      TRON_BYPASS,
    ])
    const merged = source('2.2.0-tron', [
      '  /**',
      '   * Tron USDT returns nothing from transfer().',
      '   */',
      TRON_BYPASS,
    ])

    expect(missingForkLines('', overlay, '', merged)).toEqual([])
  })

  it('counts a duplicated added line once per missing copy', () => {
    const twice = source('2.1.3-tron', [TRON_BYPASS, TRON_BYPASS])
    const once = source('2.1.3-tron', [TRON_BYPASS])

    expect(missingForkLines('', twice, '', once)).toEqual([TRON_BYPASS.trim()])
  })

  it.each([
    ['a pragma', `pragma solidity ^0.8.17; ${TRON_BYPASS.trim()}`],
    ['a closed block comment', `/* tron */ ${TRON_BYPASS.trim()}`],
  ])('counts code after %s as code', (_label, line) => {
    const overlay = `${line}\n${upstreamV1}`

    expect(
      missingForkLines(upstreamV1, overlay, upstreamV1, upstreamV1)
    ).toEqual([line])
  })

  it('treats every line as added when upstream had no base file', () => {
    expect(missingForkLines('', overlayV1, '', overlayV1)).toEqual([])
  })
})

describe('checkOverlays', () => {
  it('passes an overlay correctly rebased onto a new upstream version', () => {
    expect(codes([state({})])).toEqual([])
  })

  it('passes a redeploy revision of the overlay', () => {
    expect(
      codes([
        state({
          afterSource: source('2.2.0-tron-r2', withTron(UPSTREAM_BODY_V2)),
        }),
      ])
    ).toEqual([])
  })

  it('fails a deleted overlay and reports nothing else for it', () => {
    expect(codes([state({ afterSource: null })])).toEqual(['OVERLAY_DELETED'])
  })

  it('fails when upstream no longer has the file', () => {
    expect(codes([state({ upstreamSource: null })])).toEqual([
      'OVERLAY_UPSTREAM_MISSING',
    ])
  })

  it('fails a dropped suffix that kept the Tron code', () => {
    expect(
      codes([
        state({ afterSource: source('2.2.0', withTron(UPSTREAM_BODY_V2)) }),
      ])
    ).toEqual(['OVERLAY_SUFFIX_LOST'])
  })

  it('fails a removed version tag', () => {
    expect(
      codes([
        state({
          afterSource: [
            'library LibAsset {',
            ...withTron(UPSTREAM_BODY_V2),
            '}',
          ].join('\n'),
        }),
      ])
    ).toEqual(['OVERLAY_SUFFIX_LOST'])
  })

  it('fails a resolution that took upstream wholesale', () => {
    expect(codes([state({ afterSource: upstreamV2 })])).toEqual([
      'OVERLAY_SUFFIX_LOST',
      'OVERLAY_DELTA_LOST',
    ])
  })

  it('fails a merge that dropped the bypass but kept the constant', () => {
    const partial = source('2.2.0-tron', [TRON_CONSTANT, ...UPSTREAM_BODY_V2])
    const findings = checkOverlays([state({ afterSource: partial })])

    expect(findings.map(({ code }) => code)).toEqual(['OVERLAY_DELTA_LOST'])
    expect(findings[0]?.message).toContain(TRON_BYPASS.trim())
    expect(findings[0]?.message).not.toContain(TRON_CONSTANT.trim())
  })

  it('fails a resolution that kept the fork file while upstream moved on', () => {
    expect(codes([state({ afterSource: overlayV1 })])).toEqual([
      'OVERLAY_BASE_STALE',
    ])
  })

  it('fails the base check when upstream carries a -tron version', () => {
    expect(
      codes([state({ upstreamSource: source('2.2.0-tron', UPSTREAM_BODY_V2) })])
    ).toEqual(['OVERLAY_BASE_STALE'])
  })

  it('skips an overlay the sync did not reach', () => {
    const accepted = source('2.1.3-tron', UPSTREAM_BODY)

    expect(
      codes([
        state({
          beforeSource: accepted,
          afterSource: accepted,
          previousUpstreamSource: upstreamV2,
          upstreamSource: upstreamV2,
        }),
      ])
    ).toEqual([])
  })

  it('reports findings per file, in input order', () => {
    const other = 'src/Helpers/WithdrawablePeriphery.sol'
    const findings = checkOverlays([
      state({ path: other, afterSource: null }),
      state({}),
      state({ afterSource: source('2.2.0', withTron(UPSTREAM_BODY_V2)) }),
    ])

    expect(findings.map(({ path }) => path)).toEqual([other, PATH])
  })
})

describe('isReachedBySync', () => {
  it.each([
    ['the fork file changed', { upstreamSource: upstreamV1 }, true],
    ['upstream changed', { afterSource: overlayV1 }, true],
    [
      'neither changed',
      { afterSource: overlayV1, upstreamSource: upstreamV1 },
      false,
    ],
  ])('%s -> %p', (_label, overrides, expected) => {
    expect(isReachedBySync(state(overrides))).toBe(expected)
  })
})
