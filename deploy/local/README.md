# Local deployment

`npm run contracts:deploy:local` creates the ignored `985.json` manifest after verifying chain
ID 985. On loopback Anvil only, the script installs an isolated v0.7 EntryPoint runtime at the
canonical address, deploys the two registries and a dedicated SimpleAccountFactory, creates the
Relayer Smart Account and funds its EntryPoint deposit.
