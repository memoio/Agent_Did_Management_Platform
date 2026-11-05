import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { resolve } from "node:path";
import { ApiController } from "./api.controller.js";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: resolve("apps/console/public"),
      exclude: ["/api/{*path}"],
    }),
  ],
  controllers: [ApiController],
})
export class AppModule {}
