import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { resolve } from "node:path";
import { ApiController } from "./api.controller.js";
import { ChainService } from "./chain.service.js";
import { PlatformDb } from "./db.js";
import { PlatformService } from "./platform.service.js";
import { PairingService } from "./pairing.service.js";
import { ChainMirrorService } from "./chain-mirror.service.js";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: resolve("apps/console/public"),
      exclude: ["/api/{*path}"],
    }),
  ],
  controllers: [ApiController],
  providers: [ChainService, PlatformDb, PlatformService, PairingService, ChainMirrorService],
})
export class AppModule {}
