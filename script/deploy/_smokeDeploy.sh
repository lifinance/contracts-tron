#!/usr/bin/env bash
set -o pipefail

NETWORK=localanvil
ENVIRONMENT=staging
RPC_URL=http://localhost:8545
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 1. Pre-fund pauser wallet so stage 9 skips its `read` prompt
PAUSER=$(jq -r '.pauserWallet' config/global.json)
cast send --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" --value 1ether "$PAUSER" >/dev/null

# 2. Mock gum so the stage-selection prompt auto-picks "1)"
gum() {
if [[ "${1:-}" == "choose" ]]; then
    echo "1) Initial setup and CREATE3Factory deployment"
else
    command gum "$@"
fi
}
export -f gum

# 3. Drive the real deploy script
source script/deploy/deployAllContracts.sh
deployAllContracts "$NETWORK" "$ENVIRONMENT"