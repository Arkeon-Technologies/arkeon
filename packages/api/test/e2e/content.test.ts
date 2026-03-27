import { describe, expect, test } from "vitest";

import {
  apiRequest,
  baseUrl,
  computeCidFromText,
  createCommons,
  createEntity,
  jsonRequest,
  registerAgent,
  runPresignedE2E,
  uniqueName,
  uploadDirectContent,
} from "./helpers";

describe("content", () => {
  test("direct upload stores, serves, renames, and deletes content", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("content-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "file", { label: uniqueName("content-entity") });

    const uploaded = await uploadDirectContent(owner.apiKey, entity.id, "original", 1, "hello from file content", "hello.txt");
    expect(uploaded.ver).toBe(2);

    const { response: getResponse, body: getBody } = await apiRequest(`/entities/${entity.id}`);
    expect(getResponse.status).toBe(200);
    expect((getBody as any).entity.properties.content.original.cid).toBe(uploaded.cid);

    const downloadResponse = await fetch(`${baseUrl}/entities/${entity.id}/content?key=original`, {
      headers: { authorization: `ApiKey ${owner.apiKey}` },
    });
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-disposition")).toBe('attachment; filename="hello.txt"');
    expect(await downloadResponse.text()).toBe("hello from file content");

    const { response: renameResponse, body: renameBody } = await jsonRequest(`/entities/${entity.id}/content`, {
      method: "PATCH",
      apiKey: owner.apiKey,
      json: { from: "original", to: "archived", ver: 2 },
    });
    expect(renameResponse.status).toBe(200);
    expect((renameBody as any).ver).toBe(3);

    const { response: deleteResponse } = await apiRequest(`/entities/${entity.id}/content?key=archived&ver=3`, {
      method: "DELETE",
      apiKey: owner.apiKey,
    });
    expect(deleteResponse.status).toBe(204);
  });

  test.skipIf(!runPresignedE2E)("presigned upload signs, uploads, and finalizes content", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("presigned-commons") });
    const entity = await createEntity(owner.apiKey, commons.id, "file", { label: uniqueName("presigned-entity") });
    const content = "hello from presigned upload";
    const cid = await computeCidFromText(content);

    const { response: urlResponse, body: urlBody } = await jsonRequest(`/entities/${entity.id}/content/upload-url`, {
      method: "POST",
      apiKey: owner.apiKey,
      json: { cid, content_type: "text/plain", size: Buffer.byteLength(content) },
    });
    expect(urlResponse.status).toBe(200);

    const putResponse = await fetch((urlBody as any).upload_url, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: content,
    });
    expect(putResponse.ok).toBe(true);

    const { response: completeResponse, body: completeBody } = await jsonRequest(`/entities/${entity.id}/content/complete`, {
      method: "POST",
      apiKey: owner.apiKey,
      json: {
        key: "original",
        cid,
        size: Buffer.byteLength(content),
        content_type: "text/plain",
        filename: "presigned.txt",
        ver: 1,
      },
    });
    expect(completeResponse.status).toBe(200);
    expect((completeBody as any).ver).toBe(2);
  });
});
