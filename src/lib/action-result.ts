export type ActionResult<T = unknown> =
  | { ok: true; data?: T; message?: string; redirect?: string }
  | { ok: false; error: string; fields?: Record<string, string> };
