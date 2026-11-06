import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  ChainError,
  configuredChain,
  opbnbTestnet,
} from "../../../packages/chain-adapter/src/index.js";

@Injectable()
export class ChainService implements OnModuleDestroy {
  private connection?: ReturnType<typeof configuredChain>;

  private async useChain<T>(
    run: (chain: Awaited<ReturnType<typeof configuredChain>>) => Promise<T>,
  ): Promise<T> {
    if (
      !process.env.MEMO_CHAIN_MANIFEST_PATH ||
      !process.env.MEMO_CHAIN_MANIFEST_SHA256
    ) {
      throw new ServiceUnavailableException({
        code: "CHAIN_NOT_CONFIGURED",
        message: "A verified deployment manifest is required",
      });
    }
    try {
      this.connection ??= configuredChain();
      return await run(await this.connection);
    } catch (error) {
      throw new ServiceUnavailableException({
        code: error instanceof ChainError ? error.code : "CHAIN_UNAVAILABLE",
        message: "Chain configuration or availability check failed",
      });
    }
  }

  publicConfig() {
    return this.useChain((chain) => chain.adapter.publicConfig());
  }
  ready() {
    return this.useChain(async (chain) => {
      if (!chain.writesEnabled)
        throw new ChainError("CHAIN_STATE_UNCERTAIN", true);
      return { ...(await chain.adapter.readiness()), writesEnabled: true };
    });
  }
  async status() {
    try {
      return await this.useChain(async (chain) => ({
        state: "CHAIN_CONFIGURED",
        network: opbnbTestnet,
        chainConnected: (await chain.adapter.verifyDeployment()).verified,
        writesEnabled:
          chain.writesEnabled && Boolean(await chain.adapter.readiness()),
        errorCode: null,
      }));
    } catch (error) {
      const response =
        error instanceof ServiceUnavailableException
          ? (error.getResponse() as { code: string })
          : { code: "CHAIN_UNAVAILABLE" };
      return {
        state: "CHAIN_CONFIGURATION_REQUIRED",
        network: opbnbTestnet,
        chainConnected: false,
        writesEnabled: false,
        errorCode: response.code,
      };
    }
  }
  async onModuleDestroy() {
    if (this.connection) {
      try {
        (await this.connection).close();
      } catch {
        /* Failed initialization already closes providers. */
      }
    }
  }
}
