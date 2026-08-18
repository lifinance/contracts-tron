#!/usr/bin/env bun

import {
  MIN_BALANCE_WARNING,
  TronContractDeployer,
  createTronWeb,
  evmHexToTronBase58,
  tronAddressToHex,
  type ITronDeploymentConfig,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import {
  getEnvVar,
  getRPCEnvVarName,
  getEnvironment,
  getContractAddress,
  checkExistingDeployment,
  confirmDeployment,
  printDeploymentSummary,
  displayNetworkInfo,
  displayRegistrationInfo,
  getFacetSelectors,
} from '../../utils/utils'
import { getContractVersion } from '../shared/getContractVersion'
import { proposeDiamondCut } from '../shared/propose-diamond-cut'

import { deployContractWithLogging, validateBalance } from './tronUtils'

/**
 * Deploy and register SymbiosisFacet to Tron
 */
async function deployAndRegisterSymbiosisFacet(options: { dryRun?: boolean }) {
  consola.start('TRON SymbiosisFacet Deployment & Registration')

  const environment = getEnvironment()

  // Load environment variables
  const dryRun = options.dryRun ?? false
  let verbose = true

  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch {
    // Use default value
  }

  // Get network configuration from networks.json
  // Use tronshasta for staging/testnet, tron for production
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

  const network = networkName as SupportedChain

  // Get RPC URL from environment variable
  const envVarName = getRPCEnvVarName(network)
  const rpcUrl = getEnvVar(envVarName)

  // Get the correct private key based on environment
  let privateKey: string
  try {
    privateKey = getPrivateKeyForEnvironment(environment)
  } catch (error: any) {
    consola.error(error.message)
    consola.error(
      `Please ensure ${
        environment === EnvironmentEnum.production
          ? 'PRIVATE_KEY_PRODUCTION'
          : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  // Initialize deployer
  const config: ITronDeploymentConfig = {
    fullHost: rpcUrl,
    tvmNetworkKey: networkName as TronTvmNetworkName,
    privateKey,
    verbose,
    dryRun,
    safetyMargin: 1.5,
    maxRetries: 3,
    confirmationTimeout: 120000,
  }

  const deployer = new TronContractDeployer(config)

  try {
    // Get network info
    const networkInfo = await deployer.getNetworkInfo()

    // Use new utility for network info display
    displayNetworkInfo(networkInfo, environment, rpcUrl)

    // Initialize TronWeb
    const tronWeb = createTronWeb({
      rpcUrl,
      networkKey: networkName as TronTvmNetworkName,
      privateKey,
    })

    // Use new utility for balance validation
    await validateBalance(tronWeb, MIN_BALANCE_WARNING)

    // Load Symbiosis configuration
    const symbiosisConfig = await Bun.file('config/symbiosis.json').json()
    const tronSymbiosisConfig = symbiosisConfig.tron

    if (!tronSymbiosisConfig)
      throw new Error('Tron configuration not found in config/symbiosis.json')

    const metaRouter = tronSymbiosisConfig.metaRouter
    const gateway = tronSymbiosisConfig.gateway

    if (!metaRouter || !gateway)
      throw new Error(
        'Symbiosis metaRouter or gateway not found for tron in config/symbiosis.json'
      )

    // SymbiosisFacet v2.0.0 constructor gained the OnchainSwapV3 (syBTC -> Bitcoin)
    // args. Tron does not support that path, so the router and its gateway are
    // address(0); backendSigner is still mandatory (the constructor zero-checks it)
    // and is the same production signer used on every EVM chain.
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
    const onchainSwapV3 = tronSymbiosisConfig.onchainSwapV3 ?? ZERO_ADDRESS
    const onchainSwapV3Gateway =
      tronSymbiosisConfig.onchainSwapV3Gateway ?? ZERO_ADDRESS
    const globalConfig = await Bun.file('config/global.json').json()
    const backendSigner =
      environment === EnvironmentEnum.production
        ? globalConfig.backendSigner?.production
        : globalConfig.backendSigner?.staging
    if (!backendSigner)
      throw new Error(
        `backendSigner.${environment} not found in config/global.json`
      )

    // Convert addresses to Tron format for display
    const metaRouterTron = evmHexToTronBase58(tronWeb, metaRouter)
    const gatewayTron = evmHexToTronBase58(tronWeb, gateway)

    consola.info('\nSymbiosis Configuration:')
    consola.info(`MetaRouter: ${metaRouterTron} (hex: ${metaRouter})`)
    consola.info(`Gateway: ${gatewayTron} (hex: ${gateway})`)
    consola.info(`OnchainSwapV3: ${onchainSwapV3} (unused on Tron)`)
    consola.info(
      `OnchainSwapV3Gateway: ${onchainSwapV3Gateway} (unused on Tron)`
    )
    consola.info(`BackendSigner: ${backendSigner}`)

    // Prepare deployment plan
    const contracts = ['SymbiosisFacet']

    // Use new utility for confirmation
    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    // Deploy SymbiosisFacet
    consola.info('\nDeploying SymbiosisFacet...')

    // FORCE_REDEPLOY lets a non-interactive run deploy the new version even when
    // an older one is already recorded. checkExistingDeployment prompts
    // "Redeploy?" interactively and, without a TTY, that prompt cancels and exits
    // the process before we could branch on it — so skip the check entirely when
    // forcing.
    const forceRedeploy = process.env.FORCE_REDEPLOY === 'true'

    const { exists, address, shouldRedeploy } = forceRedeploy
      ? { exists: false, address: null, shouldRedeploy: true }
      : await checkExistingDeployment(network, 'SymbiosisFacet', dryRun)

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: 'SymbiosisFacet',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('SymbiosisFacet'),
        status: 'existing',
      })
    } else
      try {
        // Constructor arguments for SymbiosisFacet v2.0.0. The deployer's energy
        // estimation encodes args via ethers, which needs EVM hex (not Tron
        // base58), so normalize every address with tronAddressToHex — the same
        // pattern the AllBridge/NEARIntents Tron deploy scripts use.
        const constructorArgs = [
          tronAddressToHex(tronWeb, metaRouter),
          tronAddressToHex(tronWeb, gateway),
          tronAddressToHex(tronWeb, onchainSwapV3),
          tronAddressToHex(tronWeb, onchainSwapV3Gateway),
          tronAddressToHex(tronWeb, backendSigner),
        ]

        // Deploy using new utility
        const result = await deployContractWithLogging(
          deployer,
          'SymbiosisFacet',
          constructorArgs,
          dryRun,
          network
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error('Failed to deploy SymbiosisFacet:', error.message)
        deploymentResults.push({
          contract: 'SymbiosisFacet',
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
        printDeploymentSummary(deploymentResults, dryRun)
        process.exit(1)
      }

    // Register to Diamond
    consola.info('\nProposing SymbiosisFacet diamondCut to Safe...')

    // Get diamond address
    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    const selectors = await getFacetSelectors('SymbiosisFacet')

    displayRegistrationInfo(
      'SymbiosisFacet',
      facetAddress,
      diamondAddress,
      selectors
    )

    if (dryRun)
      consola.info('Dry run - skipping diamondCut proposal for SymbiosisFacet')
    else if (process.env.DEFER_CUT === 'true')
      consola.info(
        'DEFER_CUT=true - facet deployed, skipping diamondCut proposal (deferred to the backend OnchainSwapV3 cutover rollout)'
      )
    else
      await proposeDiamondCut({
        facetName: 'SymbiosisFacet',
        facetAddressHex: tronAddressToHex(
          tronWeb,
          facetAddress
        ) as `0x${string}`,
        diamondAddress,
        network: network,
      })

    printDeploymentSummary(deploymentResults, dryRun)

    consola.success(
      dryRun
        ? '\nDry run completed successfully! (no Safe tx created)'
        : '\nDeployment and proposal completed successfully!'
    )
  } catch (error: any) {
    consola.error('Deployment failed:', error.message)
    if (error.stack) consola.error(error.stack)
    process.exit(1)
  }
}

// Define CLI command
const main = defineCommand({
  meta: {
    name: 'deploy-and-register-symbiosis-facet',
    description: 'Deploy and register SymbiosisFacet to Tron Diamond',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterSymbiosisFacet({
      dryRun: args.dryRun,
    })
  },
})

// Run the command
runMain(main)
