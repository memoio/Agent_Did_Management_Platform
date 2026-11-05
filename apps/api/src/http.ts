import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => ({ schema: "memo.agent-api-result/1", ok: true, data })));
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
    const status = exception.getStatus?.() ?? 500;
    const body = exception.getResponse?.();
    const detail = body && typeof body === "object" ? body as Record<string, unknown> : {};
    response.status(status).json({
      schema: "memo.agent-api-result/1",
      ok: false,
      error: {
        code: typeof detail.code === "string" ? detail.code : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR",
        message: typeof detail.message === "string" ? detail.message : "The request could not be completed",
      },
    });
  }
}
