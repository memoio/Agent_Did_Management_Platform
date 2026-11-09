import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FetchRequest,
  JsonRpcProvider,
  Wallet,
  getAddress,
  type Signer,
} from "ethers";
import { OpbnbChainAdapter } from "./adapter.js";
import { FileSubmissionJournal } from "./journal.js";
import { ChainError, requireChain } from "./errors.js";
import { sha256 } from "./protocol.js";

export const opbnbTestnet = Object.freeze({
  name: "opBNB Testnet",
  caip2: "eip155:5611",
  chainId: 5611,
  genesisHash:
    "0x51fa57729dfb1c27542c21b06cb72a0459c57440ceb43a465dae1307cd04fe80",
  publicRpcUrl: "https://opbnb-testnet-rpc.bnbchain.org",
  explorerUrl: "https://opbnb-testnet.bscscan.com",
  nativeCurrency: { name: "Test BNB", symbol: "tBNB", decimals: 18 },
});
type Environment = Record<string, string | undefined>;

export function configuredProviders(environment: Environment = process.env) {
  const urls = [
    environment.MEMO_PRIMARY_RPC_URL || opbnbTestnet.publicRpcUrl,
    environment.MEMO_SECONDARY_RPC_URL ||
      "https://opbnb-testnet-rpc.publicnode.com",
  ];
  try {
    const parsed = urls.map((value) => new URL(value));
    requireChain(
      parsed.every((url) => url.protocol === "https:" && !url.hash),
      "NETWORK_MISMATCH",
    );
    requireChain(parsed[0].href !== parsed[1].href, "NETWORK_MISMATCH");
    return urls.map((url) => {
      const request = new FetchRequest(url);
      request.timeout = 20_000;
      return new JsonRpcProvider(
        request,
        { name: "opbnb-testnet", chainId: 5611 },
        { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 },
      );
    });
  } catch {
    throw new ChainError("NETWORK_MISMATCH");
  }
}

/** Server-side only. Environment keys and external signer errors are never returned. */
export async function configuredSigner(
  provider: JsonRpcProvider,
  environment: Environment = process.env,
): Promise<Signer> {
  try {
    const key = environment.MEMO_RELAYER_PRIVATE_KEY;
    const modulePath = environment.MEMO_SIGNER_MODULE_PATH;
    requireChain(Boolean(key) !== Boolean(modulePath), "CHAIN_STATE_UNCERTAIN");
    let signer: Signer;
    if (key) signer = new Wallet(key, provider);
    else {
      requireChain(
        modulePath && path.isAbsolute(modulePath),
        "CHAIN_STATE_UNCERTAIN",
      );
      const module = await import(pathToFileURL(modulePath).href);
      signer = await module.createSigner({
        provider,
        keyId: environment.MEMO_RELAYER_SIGNER_KEY_ID,
      });
    }
    requireChain(
      environment.MEMO_RELAYER_ADDRESS &&
        getAddress(await signer.getAddress()) ===
          getAddress(environment.MEMO_RELAYER_ADDRESS),
      "INVALID_SIGNATURE",
    );
    return signer;
  } catch {
    throw new ChainError("CHAIN_STATE_UNCERTAIN", true);
  }
}

function positiveWei(value: string | undefined): bigint {
  requireChain(
    typeof value === "string" && /^[1-9][0-9]*$/.test(value),
    "CHAIN_STATE_UNCERTAIN",
  );
  return BigInt(value);
}

/** One configuration entry point shared by the API and local chain call commands. */
export async function configuredChain(environment: Environment = process.env) {
  requireChain(
    environment.MEMO_CHAIN_MANIFEST_PATH &&
      environment.MEMO_CHAIN_MANIFEST_SHA256,
    "DEPLOYMENT_MISMATCH",
  );
  let manifest: unknown;
  try {
    const bytes = await readFile(environment.MEMO_CHAIN_MANIFEST_PATH);
    requireChain(
      sha256(bytes) === environment.MEMO_CHAIN_MANIFEST_SHA256.toLowerCase(),
      "DEPLOYMENT_MISMATCH",
    );
    manifest = JSON.parse(bytes.toString("utf8"));
    requireChain(
      (
        manifest as { network?: { genesisHash?: string } }
      ).network?.genesisHash?.toLowerCase() === opbnbTestnet.genesisHash,
      "NETWORK_MISMATCH",
    );
  } catch (error) {
    if (error instanceof ChainError) throw error;
    throw new ChainError("DEPLOYMENT_MISMATCH");
  }
  const providers = configuredProviders(environment);
  try {
    requireChain(
      [undefined, "false", "true"].includes(
        environment.MEMO_CHAIN_WRITES_ENABLED,
      ),
    );
    const writesEnabled = environment.MEMO_CHAIN_WRITES_ENABLED === "true";
    const options: ConstructorParameters<typeof OpbnbChainAdapter>[0] = {
      manifest,
      primary: providers[0],
      secondary: providers[1],
      allowFinalityFallback:
        environment.MEMO_ALLOW_FINALITY_FALLBACK === "true",
    };
    const journalDirectory = environment.MEMO_SUBMISSION_DIRECTORY;
    if (journalDirectory) {
      requireChain(path.isAbsolute(journalDirectory), "CHAIN_STATE_UNCERTAIN");
      const relative = path.relative(
        process.cwd(),
        path.resolve(journalDirectory),
      );
      requireChain(
        relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative),
        "CHAIN_STATE_UNCERTAIN",
      );
      options.journal = new FileSubmissionJournal(journalDirectory);
    }
    if (writesEnabled) {
      requireChain(options.journal, "CHAIN_STATE_UNCERTAIN");
      options.signer = await configuredSigner(providers[0], environment);
      options.signerHealth = async () => {
        try {
          await configuredSigner(providers[0], environment);
          return true;
        } catch {
          return false;
        }
      };
      options.minimumBalance = positiveWei(
        environment.MEMO_MINIMUM_BALANCE_WEI,
      );
      options.gasPriceCap = positiveWei(environment.MEMO_GAS_PRICE_CAP_WEI);
      options.gasLimitCap = positiveWei(environment.MEMO_GAS_LIMIT_CAP);
    }
    return {
      adapter: new OpbnbChainAdapter(options),
      writesEnabled,
      close: () => providers.forEach((provider) => provider.destroy()),
    };
  } catch (error) {
    providers.forEach((provider) => provider.destroy());
    throw error;
  }
}
