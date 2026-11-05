# Kubernetes deployment contract

This is a phase-two deployment contract, not a claim that production persistence is already
implemented. The current preprod release fails closed when `MEMO_ENVIRONMENT=production`; add and
validate the PostgreSQL/S3 adapters before creating production Deployments.

Build one immutable API/worker image and run separate Deployments with
`node dist/apps/api/src/main.js` and `node dist/apps/chain-worker/src/main.js`.
The API is stateless apart from PostgreSQL/S3 adapters; only the worker may submit UserOperations.

Required production controls:

- mount the immutable production deployment manifest read-only;
- inject KMS/HSM signer configuration and private RPC/Bundler URLs through Secrets;
- expose API readiness through `/api/v1/chain/config` and liveness through `/api/v1/health`;
- give the worker no ingress Service;
- enforce egress allowlists for both RPC endpoints, Alto, PostgreSQL, S3 and KMS;
- use a PodDisruptionBudget of one for the single active worker until distributed nonce locking is enabled.
