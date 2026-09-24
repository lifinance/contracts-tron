// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  checkOverlays,
  hasCodeDifference,
  isTronOverlay,
  touchedOverlays,
  type IOverlayFileState,
} from './tronOverlayGuard'

const PATH = 'src/Libraries/LibAsset.sol'

const source = (version: string, body: string): string =>
  [
    '// SPDX-License-Identifier: LGPL-3.0-only',
    'pragma solidity ^0.8.17;',
    '',
    '/// @title LibAsset',
    `/// @custom:version ${version}`,
    'library LibAsset {',
    body,
    '}',
    '',
  ].join('\n')

const UPSTREAM_BODY = '  function transfer() internal { token.transfer(); }'
const TRON_BODY = '  function transfer() internal { tronSafeTransfer(); }'

const upstream = source('2.1.3', UPSTREAM_BODY)
const overlay = source('2.1.3-tron', TRON_BODY)

const state = (overrides: Partial<IOverlayFileState>): IOverlayFileState => ({
  path: PATH,
  beforeSource: overlay,
  afterSource: overlay,
  upstreamSource: upstream,
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
    expect(isTronOverlay(source(version, TRON_BODY))).toBe(expected)
  })

  it('is false for a file without a version tag', () => {
    expect(isTronOverlay('library X {}')).toBe(false)
  })
})

describe('hasCodeDifference', () => {
  it('ignores comments, pragma, whitespace and the version line', () => {
    const reformatted = [
      'pragma solidity 0.8.29;',
      '/// @custom:version 9.9.9',
      '/* a block',
      ' * comment */',
      'library LibAsset {',
      `   ${UPSTREAM_BODY.trim()}   `,
      '}',
    ].join('\n')

    expect(hasCodeDifference(upstream, reformatted)).toBe(false)
  })

  it('sees a code change', () => {
    expect(hasCodeDifference(upstream, overlay)).toBe(true)
  })
})

describe('checkOverlays', () => {
  it('passes an overlay the sync left intact', () => {
    expect(codes([state({})])).toEqual([])
  })

  it('passes an overlay correctly rebased onto a new upstream version', () => {
    expect(
      codes([
        state({
          afterSource: source('2.2.0-tron', TRON_BODY),
          upstreamSource: source('2.2.0', UPSTREAM_BODY),
        }),
      ])
    ).toEqual([])
  })

  it('passes a redeploy revision of the overlay', () => {
    expect(
      codes([state({ afterSource: source('2.1.3-tron-r2', TRON_BODY) })])
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
    expect(codes([state({ afterSource: source('2.1.3', TRON_BODY) })])).toEqual(
      ['OVERLAY_SUFFIX_LOST']
    )
  })

  it('fails a removed version tag', () => {
    expect(
      codes([
        state({ afterSource: 'library LibAsset {\n' + TRON_BODY + '\n}' }),
      ])
    ).toEqual(['OVERLAY_SUFFIX_LOST'])
  })

  it('fails an overlay whose code was reverted to upstream', () => {
    expect(
      codes([state({ afterSource: source('2.1.3-tron', UPSTREAM_BODY) })])
    ).toEqual(['OVERLAY_DELTA_LOST'])
  })

  it('fails a resolution that took upstream wholesale', () => {
    expect(codes([state({ afterSource: upstream })])).toEqual([
      'OVERLAY_SUFFIX_LOST',
      'OVERLAY_DELTA_LOST',
    ])
  })

  it('fails a stale base version after upstream bumped', () => {
    expect(
      codes([state({ upstreamSource: source('2.2.0', UPSTREAM_BODY) })])
    ).toEqual(['OVERLAY_BASE_STALE'])
  })

  it('fails the base check when upstream carries a -tron version', () => {
    expect(
      codes([state({ upstreamSource: source('2.1.3-tron', UPSTREAM_BODY) })])
    ).toEqual(['OVERLAY_BASE_STALE'])
  })

  it('reports findings per file, in input order', () => {
    const other = 'src/Helpers/WithdrawablePeriphery.sol'
    const findings = checkOverlays([
      state({ path: other, afterSource: null }),
      state({}),
      state({ afterSource: source('2.1.3', TRON_BODY) }),
    ])

    expect(findings.map(({ path }) => path)).toEqual([other, PATH])
  })
})

describe('touchedOverlays', () => {
  it('lists overlays whose source the sync changed or removed', () => {
    const other = 'src/Helpers/WithdrawablePeriphery.sol'

    expect(
      touchedOverlays([
        state({}),
        state({ path: other, afterSource: null }),
        state({ path: 'src/X.sol', afterSource: overlay + '// note\n' }),
      ])
    ).toEqual([other, 'src/X.sol'])
  })

  it('is empty when no overlay changed', () => {
    expect(touchedOverlays([state({})])).toEqual([])
  })
})
