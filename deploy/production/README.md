# MEMO Mainnet production

Production deployment requires `MEMO_PRODUCTION_DEPLOYMENT_ACK=DEPLOY_NEW_EMPTY_PRODUCTION`.
The deployer verifies chain 985 and the canonical EntryPoint v0.7 runtime code hash before
broadcasting. Production contracts are immutable and indexing starts from the new deployment
blocks into an empty production database.

The current `0.1.0-preprod` API/worker deliberately refuses to start in production because its
PostgreSQL/S3 phase-two adapters are not implemented yet. Deploying contracts does not make the
runtime production-ready and must not be used to bypass that guard.
