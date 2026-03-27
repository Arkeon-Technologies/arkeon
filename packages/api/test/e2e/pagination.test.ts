import { describe, expect, test } from "vitest";

import {
  apiRequest,
  createComment,
  createCommons,
  createEntity,
  createGrant,
  registerAgent,
  uniqueName,
  waitForNotifications,
} from "./helpers";

describe("pagination", () => {
  test("commons entities pagination does not duplicate results across pages", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("pagination-commons") });

    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName(`paginated-${index}`) });
      ids.push(entity.id);
    }

    const first = await apiRequest(`/commons/${commons.id}/entities?limit=2`, { apiKey: owner.apiKey });
    expect(first.response.status).toBe(200);
    const firstBody = first.body as any;
    expect(firstBody.entities).toHaveLength(2);
    expect(firstBody.cursor).toBeTruthy();

    const second = await apiRequest(`/commons/${commons.id}/entities?limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`, { apiKey: owner.apiKey });
    expect(second.response.status).toBe(200);
    const secondBody = second.body as any;
    expect(secondBody.entities).toHaveLength(2);

    const pageIds = [...firstBody.entities, ...secondBody.entities].map((entity: any) => entity.id);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(pageIds.every((id: string) => ids.includes(id))).toBe(true);
  });

  test("comment pagination returns stable cursors across pages", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("comments-pagination-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("comments-pagination-entity") });

    const commentIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const comment = await createComment(owner.apiKey, entity.id, `comment-${index}`);
      commentIds.push(comment.id);
    }

    const first = await apiRequest(`/entities/${entity.id}/comments?limit=2`, { apiKey: owner.apiKey });
    expect(first.response.status).toBe(200);
    const firstBody = first.body as any;
    expect(firstBody.comments).toHaveLength(2);
    expect(firstBody.cursor).toBeTruthy();

    const second = await apiRequest(`/entities/${entity.id}/comments?limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`, { apiKey: owner.apiKey });
    expect(second.response.status).toBe(200);
    const secondBody = second.body as any;
    expect(secondBody.comments).toHaveLength(2);

    const pageIds = [...firstBody.comments, ...secondBody.comments].map((comment: any) => comment.id);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(pageIds.every((id: string) => commentIds.includes(id))).toBe(true);
  });

  test("inbox pagination and count work under multiple notifications", async () => {
    const owner = await registerAgent();
    const collaborator = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("inbox-pagination-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("inbox-pagination-entity") });
    await createGrant(owner.apiKey, entity.id, collaborator.entityId, "edit");

    for (let index = 0; index < 4; index += 1) {
      await createComment(collaborator.apiKey, entity.id, `notified-${index}`);
    }

    const count = await waitForNotifications(owner.apiKey, 4);
    expect(count.count).toBeGreaterThanOrEqual(4);

    const first = await apiRequest("/auth/me/inbox?limit=2", { apiKey: owner.apiKey });
    expect(first.response.status).toBe(200);
    const firstBody = first.body as any;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.cursor).toBeTruthy();

    const second = await apiRequest(`/auth/me/inbox?limit=2&cursor=${encodeURIComponent(firstBody.cursor)}`, { apiKey: owner.apiKey });
    expect(second.response.status).toBe(200);
    const secondBody = second.body as any;
    expect(secondBody.items).toHaveLength(2);

    const pageIds = [...firstBody.items, ...secondBody.items].map((item: any) => item.id);
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });
});
