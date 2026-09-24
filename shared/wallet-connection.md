# Wallet connection

## Smart contract accounts

OKX Wallet accounts created with a social login, such as Apple ID, are smart
contract accounts rather than standard externally-owned accounts (EOAs). Our
flow assumes an EOA, so a contract account can fail to sign or simulate
transactions and can't be funded by a plain transfer in the usual way; full
support needs EIP-4337 handling and is on the roadmap.
