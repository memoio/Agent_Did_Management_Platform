import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { resolve } from "node:path";
import { ApiController } from "./api.controller.js";
import { ChainService } from "./chain.service.js";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: resolve("apps/console/public"),
      exclude: ["/api/{*path}"],
    }),
  ],
  controllers: [ApiController],
  providers: [ChainService],
})
export class AppModule {}
