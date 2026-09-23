#!/usr/bin/env bash
# Publish the verified source of every deployed GRIDFLEX contract on OKLink,
# so an address page on the X Layer testnet explorer shows Solidity, not
# bytecode.
#
#   OKLINK_API_KEY=... contracts/scripts/verify_contracts.sh          core + every market
#   OKLINK_API_KEY=... contracts/scripts/verify_contracts.sh --core   GridOracle, MockUSDT, MarketFactory only
#   OKLINK_API_KEY=... contracts/scripts/verify_contracts.sh --dry-run
#
# Reads shared/addresses.json: the three core contracts, then every market
# with its YES and NO tokens. Constructor arguments for the core contracts
# are ABI-encoded here from that file; for markets and tokens Forge reads
# them back from the creation code (--guess-constructor-args). Verification
# is idempotent: an already verified address is reported and skipped.
#
# Needs an OKLink API key (free, from the OKLink developer portal) in
# OKLINK_API_KEY, Foundry, and the same solc the contracts were built with
# (foundry.toml pins 0.8.36; forge picks it up). Nothing here sends a
# transaction or needs a wallet.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root/contracts"

verifier_url="https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET"
chain_id=1952
addresses="$repo_root/shared/addresses.json"

core_only=0
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --core) core_only=1 ;;
    --dry-run) dry_run=1 ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

if [[ "$dry_run" == 0 && -z "${OKLINK_API_KEY:-}" ]]; then
  echo "OKLINK_API_KEY is not set." >&2
  exit 1
fi

json() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$addresses" "$1"
}

file_chain="$(json 'd["chainId"]')"
if [[ "$file_chain" != "$chain_id" ]]; then
  echo "shared/addresses.json is for chain $file_chain, not X Layer testnet ($chain_id)." >&2
  exit 1
fi

oracle="$(json 'd["GridOracle"]')"
usdt="$(json 'd["MockUSDT"]')"
factory="$(json 'd["MarketFactory"]')"
reporter="$(json 'd["reporter"]')"
dispute_window="${ORACLE_DISPUTE_WINDOW:-3600}"

verify() {
  local address="$1" contract="$2"
  shift 2
  echo
  echo "== $contract at $address"
  if [[ "$dry_run" == 1 ]]; then
    echo "   forge verify-contract --chain-id $chain_id --verifier oklink $address $contract $*"
    return 0
  fi
  forge verify-contract \
    --chain-id "$chain_id" \
    --verifier oklink \
    --verifier-url "$verifier_url" \
    --api-key "$OKLINK_API_KEY" \
    --watch \
    "$address" "$contract" "$@"
}

echo "Verifying GRIDFLEX contracts on OKLink, X Layer testnet ($chain_id)"
if [[ "$dry_run" == 0 ]]; then forge build --quiet; fi

verify "$oracle" src/GridOracle.sol:GridOracle \
  --constructor-args "$(cast abi-encode 'constructor(address,uint64)' "$reporter" "$dispute_window")"
verify "$usdt" src/MockUSDT.sol:MockUSDT
verify "$factory" src/MarketFactory.sol:MarketFactory

if [[ "$core_only" == 1 ]]; then
  exit 0
fi

count="$(json 'len(d.get("markets", []))')"
for ((i = 0; i < count; i++)); do
  market="$(json "d['markets'][$i]['market']")"
  yes_token="$(json "d['markets'][$i]['yesToken']")"
  no_token="$(json "d['markets'][$i]['noToken']")"
  verify "$market" src/BinaryMarket.sol:BinaryMarket --guess-constructor-args
  verify "$yes_token" src/OutcomeToken.sol:OutcomeToken --guess-constructor-args
  verify "$no_token" src/OutcomeToken.sol:OutcomeToken --guess-constructor-args
done

echo
echo "Done. Open an address on https://www.oklink.com/x-layer-testnet to see its source."
