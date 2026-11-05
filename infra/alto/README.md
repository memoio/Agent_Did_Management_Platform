# Dedicated Alto v0.7 bundler

The local profile pins Alto `v1.2.8` at source commit
`37cade5d2804a60ab30362ea27054514e1d7a7c8` (official image digest
`sha256:f2661042aadefc6a4fc9c5826a14404f574c7ef2de76bdf83fe6a0829137b3c5`) and enables only the canonical
EntryPoint v0.7 address. Because the published image is affected by
[upstream issue #756](https://github.com/pimlicolabs/alto/issues/756), Compose builds both the ESM runtime
and all simulation contracts from that immutable source commit. Do not copy `src/contracts` from the
published image: doing so reintroduces the missing `DelegateAndRevert` ABI. The two development executor keys in `docker-compose.yml`
belong to the public Anvil test mnemonic and are forbidden outside the loopback `local`
environment.

The pinned source is patched at build time by `apply-source-patches.mjs` for one Anvil tracer
compatibility case: if the final trace item is the canonical EntryPoint v0.7
`DelegateAndRevert(true, returnData)` envelope, SafeValidator decodes the inner
`simulateValidation` result. The patch asserts the exact upstream source text and makes the image
build fail if that source changes; all other selectors and unsuccessful delegate calls still fail
closed.

Contract artifacts are compiled in the pinned Linux AMD64 Foundry stage because upstream Solidity
does not publish native Linux ARM64 solc binaries. The artifacts are architecture-independent and are
then copied into the native Node runtime image. Node/Corepack for that build stage is copied from the
pinned official Node 20.12.2 Debian image, so building does not depend on mutable NodeSource or Ubuntu
package repositories.

Preprod and production must run separate Alto instances with:

- `safeMode=true`;
- only EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032`;
- an RPC supporting `debug_traceCall`;
- executor and utility keys delivered through the platform secret manager;
- no Paymaster configuration;
- network policies that expose JSON-RPC only to the API/worker namespace.

Before promotion, push this source-built image to the private registry, run the upstream bundler specification suite,
and record its resulting image digest in deployment evidence. The digest is mandatory; a mutable image tag is not sufficient for production.
