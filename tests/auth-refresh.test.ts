import assert from "node:assert/strict";
import test from "node:test";
import { RolayApiClient, RolayApiError } from "../src/api/client";
import type { RolaySessionState } from "../src/settings/data";

function setup() {
  let session: RolaySessionState | null = {
    accessToken: "old-access", refreshToken: "old-refresh", user: null, authenticatedAt: ""
  };
  const client = new RolayApiClient({
    getServerUrl: () => "https://example.test",
    getSession: () => session,
    saveSession: async (next) => { session = next; }
  });
  return { client, get: () => session, set: (next: RolaySessionState | null) => { session = next; } };
}

test("parallel refresh and late old-token 401 rotate the refresh token only once", async () => {
  const { client, get } = setup();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  Object.assign(client, { requestJson: async () => {
    calls++;
    await gate;
    return { accessToken: "new-access", refreshToken: "new-refresh" };
  } });
  const work = Array.from({ length: 12 }, () => client.refresh("old-access"));
  release();
  await Promise.all(work);
  await client.refresh("old-access");
  assert.equal(calls, 1);
  assert.equal(get()?.refreshToken, "new-refresh");
});

test("refresh failure cannot erase a session replaced by another login", async () => {
  const { client, get, set } = setup();
  Object.assign(client, { requestJson: async () => {
    set({ accessToken: "login-access", refreshToken: "login-refresh", user: null, authenticatedAt: "" });
    throw new RolayApiError(401, "expired");
  } });
  await assert.rejects(client.refresh());
  assert.equal(get()?.refreshToken, "login-refresh");
});

test("logout during refresh cannot be undone by a late successful response", async () => {
  const { client, get, set } = setup();
  Object.assign(client, { requestJson: async () => {
    set(null);
    return { accessToken: "new-access", refreshToken: "new-refresh" };
  } });
  await assert.rejects(client.refresh(), /Session changed/);
  assert.equal(get(), null);
});

test("failed refresh is released so transient failures can retry", async () => {
  const { client, get } = setup();
  let calls = 0;
  Object.assign(client, { requestJson: async () => {
    if (++calls === 1) { throw new Error("offline"); }
    return { accessToken: "new-access", refreshToken: "new-refresh" };
  } });
  await assert.rejects(client.refresh(), /offline/);
  await client.refresh();
  assert.equal(get()?.accessToken, "new-access");
});
