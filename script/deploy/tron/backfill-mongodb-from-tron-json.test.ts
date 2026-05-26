import {
  describe,
  it,
  expect,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import {
  buildBackfillRecord,
  type IBackfillDeps,
} from './backfill-mongodb-from-tron-json'

const deps: IBackfillDeps = {
  globalConfig: {
    pauserWallet: '0x0000000000000000000000000000000000000001',
    feeCollectorOwner: '0x0000000000000000000000000000000000000002',
    refundWallet: '0x0000000000000000000000000000000000000003',
    withdrawWallet: '0x0000000000000000000000000000000000000004',
    backendSigner: {
      production: '0x0000000000000000000000000000000000000005',
      staging: '0x0000000000000000000000000000000000000005',
    },
    tronWallets: {
      deployerWallet: 'TYsbWxNnyTgsZaTFaue9hqpWoPzMRcBSL5',
    },
  },
  networksConfig: {
    tron: {
      nativeAddress: '0x0000000000000000000000000000000000000006',
      wrappedNativeAddress: '0x0000000000000000000000000000000000000007',
      converterAddress: '',
      safeAddress: 'TWaXfPS9DjfTAuACBQU8q72mGE8aSn5HcG',
    },
  },
  allbridgeConfig: {
    tron: { allBridge: '0x000000000000000000000000000000000000000a' },
  },
  ecoConfig: { tron: { portal: '0x000000000000000000000000000000000000000b' } },
  symbiosisConfig: {
    tron: {
      metaRouter: '0x000000000000000000000000000000000000000c',
      gateway: '0x000000000000000000000000000000000000000d',
    },
  },
  timelockConfig: { minDelay: 86400 },
  tronJson: {
    LiFiDiamond: 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt',
    ERC20Proxy: 'TDCo8wrqwRVC7HaRAAsuCdbnS4AdAdtcn9',
  },
  legacyTimestamps: {
    AccessManagerFacet: new Date('2025-08-04T11:27:42.000Z'),
  },
  contractVersions: {
    AccessManagerFacet: '1.0.0',
    LiFiDiamond: '1.0.0',
  },
}

describe('buildBackfillRecord', () => {
  it('produces a valid IDeploymentRecord with required fields', async () => {
    const record = await buildBackfillRecord(
      'AccessManagerFacet',
      'TLqbL8MKosbLxrJ9iTDTpZTzcXRWq8bFJ3',
      deps
    )

    expect(record.contractName).toBe('AccessManagerFacet')
    expect(record.network).toBe('tron')
    expect(record.version).toBe('1.0.0')
    expect(record.address).toBe('TLqbL8MKosbLxrJ9iTDTpZTzcXRWq8bFJ3')
    expect(record.optimizerRuns).toBe('1000000')
    expect(record.salt).toBe('')
    expect(record.verified).toBe(false)
    expect(record.zkSolcVersion).toBe('')
    expect(record.contractNetworkKey).toBe('AccessManagerFacet-tron')
    expect(record.contractVersionKey).toBe('AccessManagerFacet-1.0.0')
    expect(record.timestamp).toEqual(new Date('2025-08-04T11:27:42.000Z'))
  })

  it('falls back to current date when contract is absent from legacy log', async () => {
    const before = Date.now()
    const record = await buildBackfillRecord(
      'LiFiDiamond',
      'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt',
      deps
    )
    const after = Date.now()

    expect(record.timestamp.getTime()).toBeGreaterThanOrEqual(before)
    expect(record.timestamp.getTime()).toBeLessThanOrEqual(after)
  })
})
