import { describe, expect, test } from "vitest";

import { getJson } from "./helpers";

describe("health", () => {
  test("GET / returns healthy status", async () => {
    const { response, body } = await getJson("/");

    expect(response.status).toBe(200);
    expect(body.name).toBe("arke-api");
    expect(body.status).toBe("ok");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  test("public read endpoints expose the root commons", async () => {
    const { response: activityResponse, body: activityBody } = await getJson("/activity");
    expect(activityResponse.status).toBe(200);
    expect(Array.isArray(activityBody.activity)).toBe(true);

    const { response: commonsResponse, body: commonsBody } = await getJson("/commons");
    expect(commonsResponse.status).toBe(200);
    expect(Array.isArray(commonsBody.commons)).toBe(true);
    expect(commonsBody.commons.length).toBeGreaterThan(0);

    const { response: entityResponse, body: entityBody } = await getJson("/entities/00000000000000000000000000");
    expect(entityResponse.status).toBe(200);
    expect(entityBody.entity.id).toBe("00000000000000000000000000");
    expect(entityResponse.headers.get("etag")).toMatch(/1/);
  });
});
