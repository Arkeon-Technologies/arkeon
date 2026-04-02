import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  addGroupMember,
  apiRequest,
  createActor,
  createGroup,
  getArkeId,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Groups", () => {
  let arkeId: string;

  test("setup: get arkeId", async () => {
    arkeId = await getArkeId();
  });

  test("Admin can create group", async () => {
    const group = await createGroup(adminApiKey, arkeId, uniqueName("test-group"));
    expect(group.id).toBeTruthy();
    expect(group.name).toContain("test-group");
  });

  test("Non-admin cannot create group", async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const { response } = await jsonRequest("/groups", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        name: uniqueName("no-create"),
        type: "project",
        arke_id: arkeId,
      },
    });
    expect(response.status).toBe(403);
  });

  test("List groups", async () => {
    await createGroup(adminApiKey, arkeId, uniqueName("list-group"));

    const { response, body } = await getJson("/groups", adminApiKey);
    expect(response.status).toBe(200);
    expect((body as any).groups.length).toBeGreaterThan(0);
  });

  test("Add member to group", async () => {
    const group = await createGroup(adminApiKey, arkeId, uniqueName("add-member"));
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    await addGroupMember(adminApiKey, group.id, actor.id);

    const { response, body } = await getJson(`/groups/${group.id}`, adminApiKey);
    expect(response.status).toBe(200);
    const members = (body as any).group.members;
    expect(members.some((m: any) => m.actor_id === actor.id)).toBe(true);
  });

  test("Get group with members", async () => {
    const group = await createGroup(adminApiKey, arkeId, uniqueName("get-group"));
    const actor1 = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const actor2 = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    await addGroupMember(adminApiKey, group.id, actor1.id);
    await addGroupMember(adminApiKey, group.id, actor2.id, "admin");

    const { response, body } = await getJson(`/groups/${group.id}`, adminApiKey);
    expect(response.status).toBe(200);
    const g = (body as any).group;
    expect(g.id).toBe(group.id);
    expect(g.members.length).toBe(2);
    expect(g.members.some((m: any) => m.actor_id === actor1.id && m.role_in_group === "member")).toBe(true);
    expect(g.members.some((m: any) => m.actor_id === actor2.id && m.role_in_group === "admin")).toBe(true);
  });

  test("Remove member", async () => {
    const group = await createGroup(adminApiKey, arkeId, uniqueName("remove-member"));
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    await addGroupMember(adminApiKey, group.id, actor.id);

    const { response } = await apiRequest(`/groups/${group.id}/members/${actor.id}`, {
      method: "DELETE",
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(204);

    // Verify removed
    const { body } = await getJson(`/groups/${group.id}`, adminApiKey);
    const members = (body as any).group.members;
    expect(members.some((m: any) => m.actor_id === actor.id)).toBe(false);
  });

  test("Delete group", async () => {
    const group = await createGroup(adminApiKey, arkeId, uniqueName("delete-group"));

    const { response } = await apiRequest(`/groups/${group.id}`, {
      method: "DELETE",
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(204);

    // Verify deleted
    const { response: getRes } = await getJson(`/groups/${group.id}`, adminApiKey);
    expect(getRes.status).toBe(404);
  });
});
