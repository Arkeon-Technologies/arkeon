import { describe, expect, test } from "vitest";

import { apiRequest, createComment, createCommons, createEntity, createRelationship, jsonRequest, registerAgent, uniqueName } from "./helpers";

describe("relationships and comments", () => {
  test("create, list, get, update, and delete relationships", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("rel-commons") });
    const source = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("source") });
    const target = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("target") });
    const relationship = await createRelationship(owner.apiKey, source.id, "references", target.id, { note: "v1" });
    const relId = relationship.relationship_entity.id;

    const { response: listResponse, body: listBody } = await apiRequest(`/entities/${source.id}/relationships`);
    expect(listResponse.status).toBe(200);
    expect((listBody as any).relationships.some((row: any) => row.id === relId)).toBe(true);

    const { response: directResponse, body: directBody } = await apiRequest(`/relationships/${relId}`);
    expect(directResponse.status).toBe(200);
    expect((directBody as any).id).toBe(relId);

    const { response: updateResponse, body: updateBody } = await jsonRequest(`/relationships/${relId}`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: { ver: 1, properties: { note: "v2" } },
    });
    expect(updateResponse.status).toBe(200);
    expect((updateBody as any).relationship.ver).toBe(2);

    const { response: deleteResponse } = await apiRequest(`/relationships/${relId}`, {
      method: "DELETE",
      apiKey: owner.apiKey,
    });
    expect(deleteResponse.status).toBe(204);

    const { response: missingResponse } = await apiRequest(`/relationships/${relId}`);
    expect(missingResponse.status).toBe(404);
  });

  test("create replies, list thread, reject nested reply, and delete comment", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("comment-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "note", { label: uniqueName("comment-entity") });
    const topLevel = await createComment(owner.apiKey, entity.id, "top level");
    const reply = await createComment(owner.apiKey, entity.id, "reply", topLevel.id);

    const { response: listResponse, body: listBody } = await apiRequest(`/entities/${entity.id}/comments`);
    expect(listResponse.status).toBe(200);
    expect((listBody as any).comments.some((row: any) => row.id === topLevel.id)).toBe(true);
    expect((listBody as any).comments.some((row: any) => row.replies.some((nested: any) => nested.id === reply.id))).toBe(true);

    const { response: invalidReplyResponse, body: invalidReplyBody } = await jsonRequest(`/entities/${entity.id}/comments`, {
      method: "POST",
      apiKey: owner.apiKey,
      json: { body: "invalid nested", parent_id: reply.id },
    });
    expect(invalidReplyResponse.status).toBe(400);
    expect((invalidReplyBody as any).error.code).toBe("invalid_body");

    const { response: deleteResponse } = await apiRequest(`/entities/${entity.id}/comments/${topLevel.id}`, {
      method: "DELETE",
      apiKey: owner.apiKey,
    });
    expect(deleteResponse.status).toBe(204);
  });
});
