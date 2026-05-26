import {
  describe,
  it,
  expect,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import {
  buildBackfillRecord,
  buildConstructorArgs,
  type IBackfillDeps,
} from './backfill-mongodb-from-tron-json'

// Use 0x-hex addresses throughout so TronWeb address conversion is a passthrough.
// The T-address conversion path is exercised by real-world runs; keeping fixtures
// as plain hex keeps unit tests network-free and avoids checksum validation.
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
      // Use a 0x-hex address here to keep tests network-free (codec passthrough).
      deployerWallet: '0x0000000000000000000000000000000000000009',
    },
  },
  networksConfig: {
    tron: {
      nativeAddress: '0x0000000000000000000000000000000000000006',
      wrappedNativeAddress: '0x0000000000000000000000000000000000000007',
      converterAddress: '',
      // Use a 0x-hex address so TronWeb conversion is a passthrough in tests.
      safeAddress: '0x0000000000000000000000000000000000000008',
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
    // Use 0x-hex addresses so TronWeb codec is a passthrough in tests.
    LiFiDiamond: '0x000000000000000000000000000000000000000e',
    ERC20Proxy: '0x000000000000000000000000000000000000000f',
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

describe('buildConstructorArgs', () => {
  it('returns empty array for facets with no constructor args', () => {
    const noArgFacets = [
      'AccessManagerFacet',
      'CalldataVerificationFacet',
      'DexManagerFacet',
      'DiamondCutFacet',
      'DiamondLoupeFacet',
      'GenericSwapFacet',
      'OwnershipFacet',
      'PeripheryRegistryFacet',
      'WhitelistManagerFacet',
      'WithdrawFacet',
    ]
    for (const name of noArgFacets)
      expect(buildConstructorArgs(name, deps)).toEqual([])
  })

  it('uses globalConfig.pauserWallet for EmergencyPauseFacet', () => {
    const args = buildConstructorArgs('EmergencyPauseFacet', deps)
    expect(args).toEqual(['0x0000000000000000000000000000000000000001'])
  })

  it('uses networksConfig.tron.nativeAddress for GenericSwapFacetV3', () => {
    const args = buildConstructorArgs('GenericSwapFacetV3', deps)
    expect(args).toEqual(['0x0000000000000000000000000000000000000006'])
  })

  it('uses tronWallets.deployerWallet (hex-converted) for LiFiDiamond', () => {
    const args = buildConstructorArgs('LiFiDiamond', deps)
    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('uses tronWallets.deployerWallet for ERC20Proxy', () => {
    const args = buildConstructorArgs('ERC20Proxy', deps)
    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('combines ERC20Proxy address + refundWallet for Executor', () => {
    const args = buildConstructorArgs('Executor', deps)
    expect(args).toHaveLength(2)
    expect(args[0]).toMatch(/^0x[0-9a-fA-F]{40}$/) // ERC20Proxy hex
    expect(args[1]).toBe('0x0000000000000000000000000000000000000003') // refundWallet
  })

  it('uses globalConfig.feeCollectorOwner for FeeCollector', () => {
    const args = buildConstructorArgs('FeeCollector', deps)
    expect(args).toEqual(['0x0000000000000000000000000000000000000002'])
  })

  it('uses globalConfig.withdrawWallet for FeeForwarder', () => {
    const args = buildConstructorArgs('FeeForwarder', deps)
    expect(args).toEqual(['0x0000000000000000000000000000000000000004'])
  })

  it('combines wrappedNative + converter + refundWallet for TokenWrapper (zero converter when missing)', () => {
    const args = buildConstructorArgs('TokenWrapper', deps)
    expect(args).toEqual([
      '0x0000000000000000000000000000000000000007', // wrappedNative
      '0x0000000000000000000000000000000000000000', // converter zero
      '0x0000000000000000000000000000000000000003', // refundWallet
    ])
  })

  it('uses allbridgeConfig.tron.allBridge for AllBridgeFacet', () => {
    const args = buildConstructorArgs('AllBridgeFacet', deps)
    expect(args).toEqual(['0x000000000000000000000000000000000000000a'])
  })

  it('uses ecoConfig.tron.portal for EcoFacet', () => {
    const args = buildConstructorArgs('EcoFacet', deps)
    expect(args).toEqual(['0x000000000000000000000000000000000000000b'])
  })

  it('uses globalConfig.backendSigner.production for NEARIntentsFacet (production env)', () => {
    const args = buildConstructorArgs('NEARIntentsFacet', deps, 'production')
    expect(args).toEqual(['0x0000000000000000000000000000000000000005'])
  })

  it('uses globalConfig.backendSigner.staging for NEARIntentsFacet (staging env)', () => {
    const stagingDeps: IBackfillDeps = {
      ...deps,
      globalConfig: {
        ...deps.globalConfig,
        backendSigner: {
          production: '0x0000000000000000000000000000000000000005',
          staging: '0x000000000000000000000000000000000000000e',
        },
      },
    }
    const args = buildConstructorArgs(
      'NEARIntentsFacet',
      stagingDeps,
      'staging'
    )
    expect(args).toEqual(['0x000000000000000000000000000000000000000e'])
  })

  it('uses [metaRouter, gateway] for SymbiosisFacet', () => {
    const args = buildConstructorArgs('SymbiosisFacet', deps)
    expect(args).toEqual([
      '0x000000000000000000000000000000000000000c',
      '0x000000000000000000000000000000000000000d',
    ])
  })

  it('uses [minDelay, [safe], [zero], deployer, safe, diamond] for LiFiTimelockController', () => {
    const args = buildConstructorArgs('LiFiTimelockController', deps)
    expect(args).toHaveLength(6)
    expect(args[0]).toBe(86400) // minDelay
    expect(Array.isArray(args[1])).toBe(true) // proposers
    expect((args[1] as string[])[0]).toMatch(/^0x[0-9a-fA-F]{40}$/) // safe
    expect(args[2]).toEqual(['0x0000000000000000000000000000000000000000']) // executors
    expect(args[3]).toMatch(/^0x[0-9a-fA-F]{40}$/) // deployer (canceller)
    expect(args[4]).toMatch(/^0x[0-9a-fA-F]{40}$/) // safe
    expect(args[5]).toMatch(/^0x[0-9a-fA-F]{40}$/) // diamond
  })

  it('throws for unknown contract names', () => {
    expect(() => buildConstructorArgs('UnknownContract', deps)).toThrow(
      /Unknown contract/
    )
  })
})
