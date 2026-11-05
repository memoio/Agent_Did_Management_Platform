import "reflect-metadata";
import { RuntimeConfigService } from "../../api/src/config.service.js";
import { ChainStore } from "../../api/src/store.service.js";
import { ChainHealthService } from "../../api/src/chain-health.service.js";
import { ChainWorker } from "./worker.js";

const config = new RuntimeConfigService();
const store = new ChainStore(config);
const health = new ChainHealthService(config);
const worker = new ChainWorker(config, store, health);
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

try {
  await worker.run(controller.signal);
} finally {
  store.onModuleDestroy();
}
