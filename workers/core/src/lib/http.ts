import type { Context } from "hono";
import type { ApiErrorEnvelope, ErrorCode } from "@app/core-contract";
import type { HonoEnv } from "../env.js";

export class AppError extends Error {
  constructor(
    readonly status:
      400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 503,
    readonly code: ErrorCode | string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errorResponse = (c: Context<HonoEnv>, error: AppError) => {
  const payload: ApiErrorEnvelope = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      requestId: c.get("requestId"),
    },
  };
  return c.json(payload, error.status);
};

export const parseBody = async <T>(
  c: Context<HonoEnv>,
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      data?: T;
      error?: { flatten: () => { fieldErrors: Record<string, string[]> } };
    };
  },
): Promise<T> => {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    throw new AppError(
      400,
      "BAD_JSON",
      "The request body must contain valid JSON.",
    );
  }
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Revise os campos informados.",
      result.error?.flatten().fieldErrors,
    );
  return result.data as T;
};

export const noStore = { "Cache-Control": "no-store" };
