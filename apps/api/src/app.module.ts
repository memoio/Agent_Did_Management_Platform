import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { resolve } from "node:path";
import { RuntimeConfigService } from "./config.service.js";
import { ChainStore } from "./store.service.js";
import { ContentAddressedObjectStore } from "./object-store.service.js";
import { SessionService } from "./session.service.js";
import { IntentService } from "./intent.service.js";
import { PairingService } from "./pairing.service.js";
import { ResolverService } from "./resolver.service.js";
import { ChainHealthService } from "./chain-health.service.js";
import { DashboardService } from "./dashboard.service.js";
import { ApiController } from "./api.controller.js";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: resolve("apps/console/public"),
      exclude: ["/api/{*path}"],
    }),
  ],
  controllers: [ApiController],
  providers: [
    { provide: RuntimeConfigService, useFactory: () => new RuntimeConfigService() },
    ChainStore,
    ContentAddressedObjectStore,
    SessionService,
    IntentService,
    PairingService,
    ResolverService,
    ChainHealthService,
    DashboardService,
  ],
})
export class AppModule {}
