/**
 * One-off backfill: writes Tron production deployment records to MongoDB from
 * `deployments/tron.json` + the legacy `_deployments_log_file.json`. Reconstructs
 * constructor args from current repo config (best-effort — see spec).
 *
 * Usage: `bun ./script/deploy/tron/backfill-mongodb-from-tron-json.ts [--dryRun] [--environment <production|staging>]`
 *
 * NOTE: citty does NOT auto-convert `--dry-run` (kebab) to `args.dryRun`.
 * Use camel-case `--dryRun` to enter the preview path; the kebab form is
 * silently ignored and the script writes to MongoDB.
 *
 * **Invocation:** Run with `bun`, not the project-default `bunx tsx`.
 * The shared `getContractVersion` helper uses `Bun.file()`, which is undefined
 * under tsx's Node-compatible runtime. This is the only script in the repo
 * that documents this deviation from rule 200-typescript.md.
 *
 * Idempotent: `logDeploymentBatch` upserts on (contractName, network, version, address).
 * Contracts whose source is not present in this repo (e.g. DexManagerFacet) are
 * skipped with a warning — they need a separate manual entry.
 */

import { existsSync, readFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { IDeploymentRecord } from '../shared/mongo-log-utils'

/**
 * Bundle of all repo configs the backfill needs to reconstruct a deployment record.
 * Passed as a single argument so unit tests can supply fixtures without touching the filesystem.
 */
// Config fields (globalConfig, networksConfig, allbridgeConfig, ecoConfig,
// symbiosisConfig, timelockConfig) are unused by buildBackfillRecord in Task 2;
// Task 3 wires them through to derive constructor args.
export interface IBackfillDeps {
  globalConfig: Record<string, unknown>
  networksConfig: Record<string, Record<string, unknown>>
  allbridgeConfig: Record<string, { allBridge?: string }>
  ecoConfig: Record<string, { portal?: string }>
  symbiosisConfig: Record<string, { metaRouter?: string; gateway?: string }>
  timelockConfig: { minDelay?: number | string }
  tronJson: Record<string, string>
  legacyTimestamps: Record<string, Date>
  contractVersions: Record<string, string>
}

/**
 * Build an IDeploymentRecord for a single Tron contract.
 *
 * @param contractName - Name as it appears in `deployments/tron.json`.
 * @param address - Base58 (T-prefixed) Tron address.
 * @param deps - Pre-loaded configs and lookups.
 * @returns Record ready for `logDeploymentBatch`. Constructor args are stubbed
 *   to `'0x'` in this version; Task 3 wires the real derivation.
 */
export async function buildBackfillRecord(
  contractName: string,
  address: string,
  deps: IBackfillDeps
): Promise<Omit<IDeploymentRecord, 'createdAt' | 'updatedAt' | '_id'>> {
  const version = deps.contractVersions[contractName]
  if (!version)
    throw new Error(
      `Version not resolved for ${contractName}. Ensure source contract has '@custom:version' NatSpec.`
    )

  const timestamp = deps.legacyTimestamps[contractName] ?? new Date()

  return {
    contractName,
    network: 'tron',
    version,
    address,
    optimizerRuns: '1000000',
    timestamp,
    constructorArgs: '0x',
    salt: '',
    verified: false,
    solcVersion: '0.8.29', // from foundry.toml — keep in sync if upgrade
    evmVersion: 'cancun', // from foundry.toml — keep in sync if upgrade
    zkSolcVersion: '',
    contractNetworkKey: `${contractName}-tron`,
    contractVersionKey: `${contractName}-${version}`,
  }
}

async function loadDeps(): Promise<IBackfillDeps> {
  const readJson = <T>(path: string, fallback: T): T => {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8')) as T
  }

  const globalConfig = readJson<Record<string, unknown>>(
    'config/global.json',
    {}
  )
  const networksConfig = readJson<Record<string, Record<string, unknown>>>(
    'config/networks.json',
    {}
  )
  const allbridgeConfig = readJson<Record<string, { allBridge?: string }>>(
    'config/allbridge.json',
    {}
  )
  const ecoConfig = readJson<Record<string, { portal?: string }>>(
    'config/eco.json',
    {}
  )
  const symbiosisConfig = readJson<
    Record<string, { metaRouter?: string; gateway?: string }>
  >('config/symbiosis.json', {})
  const timelockConfig = readJson<{ minDelay?: number | string }>(
    'config/timelockController.json',
    {}
  )
  const tronJson = readJson<Record<string, string>>('deployments/tron.json', {})

  // Parse legacy log to recover original deploy timestamps (best-effort, per spec).
  const legacyLog = readJson<Record<string, unknown>>(
    'deployments/_deployments_log_file.json',
    {}
  )
  const legacyTimestamps: Record<string, Date> = {}
  for (const [contractName, contractData] of Object.entries(legacyLog)) {
    const tronData = (contractData as Record<string, unknown> | undefined)?.tron
    if (!tronData || typeof tronData !== 'object') continue
    const prod = (tronData as Record<string, unknown>).production
    if (!prod || typeof prod !== 'object') continue
    // Tron contracts have a single version entry in practice, but if a contract
    // ever has multiple, the picked timestamp depends on JSON insertion order.
    // Acceptable for a one-off best-effort backfill.
    const versions = Object.values(prod as Record<string, unknown>)
    const firstVersion = versions[0]
    if (!Array.isArray(firstVersion) || firstVersion.length === 0) continue
    const entry = firstVersion[0] as { TIMESTAMP?: string } | undefined
    if (entry?.TIMESTAMP)
      legacyTimestamps[contractName] = new Date(entry.TIMESTAMP)
  }

  const { getContractVersion } = await import('../shared/getContractVersion')
  const contractVersions: Record<string, string> = {}
  for (const name of Object.keys(tronJson))
    try {
      contractVersions[name] = await getContractVersion(name)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      consola.warn(`Skipping ${name}: version resolution failed (${msg})`)
    }

  return {
    globalConfig,
    networksConfig,
    allbridgeConfig,
    ecoConfig,
    symbiosisConfig,
    timelockConfig,
    tronJson,
    legacyTimestamps,
    contractVersions,
  }
}

const cli = defineCommand({
  meta: {
    name: 'backfill-mongodb-from-tron-json',
    description:
      'Backfill MongoDB with Tron production deployment records from deployments/tron.json.',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description:
        'Print records that would be inserted; do not write to MongoDB.',
      default: false,
    },
    environment: {
      type: 'string',
      description: 'production | staging',
      default: 'production',
    },
  },
  async run({ args }) {
    if (args.environment !== 'production' && args.environment !== 'staging') {
      consola.error(`Invalid --environment: ${args.environment}`)
      process.exit(1)
    }

    const deps = await loadDeps()
    const contracts = Object.keys(deps.tronJson)
    consola.info(
      `Found ${contracts.length} contracts in deployments/tron.json. Building records...`
    )

    const records: Array<
      Omit<IDeploymentRecord, 'createdAt' | 'updatedAt' | '_id'>
    > = []
    const failures: Array<{ name: string; reason: string }> = []

    for (const name of contracts) {
      const addr = deps.tronJson[name]
      if (!addr) continue
      try {
        const record = await buildBackfillRecord(name, addr, deps)
        records.push(record)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        failures.push({ name, reason: msg })
      }
    }

    if (failures.length > 0) {
      consola.error(`Failed to build ${failures.length} record(s):`)
      for (const f of failures) consola.error(`  - ${f.name}: ${f.reason}`)
    }

    if (args.dryRun) {
      consola.info(`[dry-run] Would upsert ${records.length} records:`)
      for (const r of records)
        consola.info(
          `  - ${r.contractName} v${r.version} @ ${
            r.address
          } (ts=${r.timestamp.toISOString()})`
        )
      process.exit(failures.length > 0 ? 1 : 0)
    }

    const { logDeploymentBatch } = await import('../shared/deployment-logger')
    await logDeploymentBatch(
      records,
      args.environment as 'production' | 'staging'
    )
    consola.success(`Wrote ${records.length} records to MongoDB.`)
    process.exit(failures.length > 0 ? 1 : 0)
  },
})

if (import.meta.main) runMain(cli)
