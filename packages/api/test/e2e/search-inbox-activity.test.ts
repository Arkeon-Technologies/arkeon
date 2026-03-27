import { describe, expect, test } from "vitest";

import {
  apiRequest,
  createComment,
  createCommons,
  createEntity,
  createGrant,
  createRelationship,
  registerAgent,
  uniqueName,
} from "./helpers";

describe("search, inbox, and activity", () => {
  test("search, inbox, count, actor activity, and commons feed reflect collaboration", async () => {
    const owner = await registerAgent();
    const collaborator = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("activity-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", {
      label: uniqueName("searchable"),
      description: "searchable phrase for e2e coverage",
    });

    await createGrant(owner.apiKey, entity.id, collaborator.entityId, "edit");
    const since = new Date().toISOString();
    const comment = await createComment(collaborator.apiKey, entity.id, "hello from collaborator");
    await createRelationship(collaborator.apiKey, entity.id, "references", "00000000000000000000000000", { note: "links to root" });

    const { response: searchResponse, body: searchBody } = await apiRequest(`/search?q=${encodeURIComponent("searchable phrase")}`);
    expect(searchResponse.status).toBe(200);
    expect((searchBody as any).results.some((row: any) => row.id === entity.id)).toBe(true);

    const { response: inboxResponse, body: inboxBody } = await apiRequest("/auth/me/inbox", {
      apiKey: owner.apiKey,
    });
    expect(inboxResponse.status).toBe(200);
    expect((inboxBody as any).items.some((item: any) => item.entity_id === entity.id)).toBe(true);

    const { response: countResponse, body: countBody } = await apiRequest(`/auth/me/inbox/count?since=${encodeURIComponent(since)}`, {
      apiKey: owner.apiKey,
    });
    expect(countResponse.status).toBe(200);
    expect((countBody as any).count).toBeGreaterThanOrEqual(1);

    const { response: actorActivityResponse, body: actorActivityBody } = await apiRequest(`/actors/${collaborator.entityId}/activity?action=comment_created`);
    expect(actorActivityResponse.status).toBe(200);
    expect((actorActivityBody as any).activity.some((item: any) => item.action === "comment_created")).toBe(true);

    const { response: globalActivityResponse, body: globalActivityBody } = await apiRequest(`/activity?actor_id=${collaborator.entityId}`);
    expect(globalActivityResponse.status).toBe(200);
    expect((globalActivityBody as any).activity.some((item: any) => item.actor_id === collaborator.entityId)).toBe(true);

    const { response: feedResponse, body: feedBody } = await apiRequest(`/commons/${commons.id}/feed`);
    expect(feedResponse.status).toBe(200);
    expect((feedBody as any).activity.some((item: any) => item.entity_id === entity.id)).toBe(true);

    expect(comment.id).toBeTruthy();
  });
});
