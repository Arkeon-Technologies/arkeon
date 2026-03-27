import { neon } from "@neondatabase/serverless";

export function createSql() {
  return neon(process.env.DATABASE_URL!);
}
