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
    const normalized = normalizeError(error);
    response.status(normalized.status).json({
      schema: "memo.agent-api-result/1",
      ok: false,
      error: { code: normalized.code, message: normalized.message },
    });
  }
}

function normalizeError(error: unknown): { status: number; code: string; message: string } {
  const value = error as { message?: string; status?: number; getStatus?: () => number };
  const raw = value?.message || "INTERNAL_ERROR";
  const code = /^[A-Z][A-Z0-9_:-]+$/.test(raw) ? raw : "INTERNAL_ERROR";
  const conflict = [
    "IDENTITY_ALREADY_REGISTERED", "IDEMPOTENCY_KEY_CONFLICT", "AGENT_REQUEST_NOT_PENDING",
    "INTENT_EXPIRED", "PAIRING_INVALID_OR_EXPIRED", "DID_NOT_CONFIRMED",
    "PAIRING_CONFLICT", "IDENTITY_NOT_ACTIVE_OR_CONFIRMED", "MANAGEMENT_DRAFT_ALREADY_SIGNED",
    "ACTIVE_MANAGEMENT_RELATIONSHIP", "PAIRING_REGISTRATION_REORGED",
  ].includes(code);
  const unauthorized = code.includes("SESSION") || code.includes("SIGNATURE") || code.includes("CHALLENGE");
  const forbidden = code.includes("ACCESS_DENIED") || code.includes("MISMATCH");
  const status = value?.getStatus?.() || value?.status || (code === "PAIRING_V1_REMOVED" ? 410 : unauthorized ? 401 : forbidden ? 403 : conflict ? 409 : code === "INTERNAL_ERROR" ? 500 : 400);
  return { status, code, message: code === "INTERNAL_ERROR" ? "The request could not be completed" : code };
}
