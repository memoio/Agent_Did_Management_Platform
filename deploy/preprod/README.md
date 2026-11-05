# MEMO Mainnet preprod

Preprod is a separate set of production-like contracts on chain 985, using only disposable test
identities. Set `MEMO_ENVIRONMENT=preprod`, two independent HTTPS RPC endpoints, confirmed native
currency metadata, deployer credentials, KMS owner address and public RPC/WSS display URLs.
Never reuse the local manifest or production database.
