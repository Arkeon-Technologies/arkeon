import { describe, expect, test } from "vitest";
import { adminApiKey, apiRequest, getArkeId, getJson } from "./helpers";

describe("Bootstrap", () => {
  test("Health check returns 200 with arkeon-api", async () => {
    const { response, body } = await apiRequest("/");
    expect(response.status).toBe(200);
    expect(body).toHaveProperty("name", "arkeon-api");
  });

  test("GET /arkes returns at least one arke", async () => {
    const { response, body } = await getJson("/arkes", adminApiKey);
    expect(response.status).toBe(200);
    expect((body as any).arkes.length).toBeGreaterThan(0);
    expect((body as any).arkes[0]).toHaveProperty("id");
  });

  test("GET /auth/me with admin key returns actor with is_admin=true and max_read_level=4", async () => {
    const { response, body } = await getJson("/auth/me", adminApiKey);
    expect(response.status).toBe(200);
    expect((body as any).actor.is_admin).toBe(true);
    expect((body as any).actor.max_read_level).toBe(4);
  });

  test("Unauthenticated GET /auth/me returns 401", async () => {
    const { response } = await apiRequest("/auth/me");
    expect(response.status).toBe(401);
  });
});
