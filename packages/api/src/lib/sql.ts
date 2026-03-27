import { neon } from "@neondatabase/serverless";

import type { Env } from "../types";

export function createSql(env: Env) {
  return neon(env.DATABASE_URL);
}
