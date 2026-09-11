import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/connections.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { loadConnections, saveConnections, sameConnection } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test("first launch differs from explicitly closing all saved connections", () => {
  const storage = createStorage();
  assert.equal(loadConnections(storage), null);
  saveConnections(storage, []);
  assert.deepEqual(loadConnections(storage), []);
});

test("connections survive reload including the environment configuration", () => {
  const storage = createStorage();
  const configs = [null, { host: "db.internal", port: "6432" }, { host: "::1", port: "5432" }];
  saveConnections(storage, configs);
  assert.deepEqual(loadConnections(storage), configs);
});

test("host, port, and username are persisted without passwords", () => {
  const storage = createStorage();
  saveConnections(storage, [{ host: "localhost", port: "5432", username: "alice", password: "not-for-storage" }]);
  assert.deepEqual(loadConnections(storage), [{ host: "localhost", port: "5432", username: "alice" }]);
  assert.ok(!storage.getItem("postgresui.connections.v1").includes("not-for-storage"));
});

test("connection names are persisted and optional", () => {
  const storage = createStorage();
  const configs = [{ name: "Production", host: "db.internal", port: "5432", username: "alice" }, { host: "localhost", port: "5432" }];
  saveConnections(storage, configs);
  assert.deepEqual(loadConnections(storage), configs);
});

test("stored passwords are ignored when loading profiles", () => {
  const storage = createStorage();
  storage.setItem("postgresui.connections.v1", JSON.stringify([
    { host: "localhost", port: "5432", username: "alice", password: "not-for-storage" },
  ]));
  assert.deepEqual(loadConnections(storage), [{ host: "localhost", port: "5432", username: "alice" }]);
});

test("malformed saved data is reported without overwriting it", () => {
  for (const value of ["broken json", "{}", "[false]", '[{"host":"","port":"5432"}]',
    '[{"host":"localhost","port":"0"}]', '[{"host":"localhost","port":"65536"}]',
    '[{"host":"localhost","port":5432}]', '[{"host":"localhost","port":"1.5"}]',
    '[{"host":"localhost","port":"5432","username":" "}]',
    '[{"host":"localhost","port":"5432","username":42}]',
    '[{"name":" ","host":"localhost","port":"5432"}]',
    '[{"name":42,"host":"localhost","port":"5432"}]']) {
    const storage = createStorage();
    storage.setItem("postgresui.connections.v1", value);
    assert.throws(() => loadConnections(storage));
    assert.equal(storage.getItem("postgresui.connections.v1"), value);
  }
});

test("storage write failures are reported rather than claiming success", () => {
  const storage = { setItem() { throw new Error("Storage unavailable"); } };
  assert.throws(() => saveConnections(storage, [{ host: "localhost", port: "5432" }]), /Storage unavailable/);
});

test("connection identity distinguishes servers and the environment default", () => {
  assert.ok(sameConnection(null, null));
  assert.ok(sameConnection({ host: "localhost", port: "5432" }, { host: "localhost", port: "5432" }));
  assert.ok(!sameConnection(null, { host: "localhost", port: "5432" }));
  assert.ok(!sameConnection({ host: "localhost", port: "5432" }, { host: "localhost", port: "6432" }));
  assert.ok(!sameConnection({ host: "localhost", port: "5432" }, { host: "other", port: "5432" }));
});

test("connection identity distinguishes usernames but ignores password changes", () => {
  const connection = { host: "localhost", port: "5432", username: "alice", password: "old" };
  assert.ok(sameConnection(connection, { ...connection, password: "new" }));
  assert.ok(sameConnection(connection, { host: "localhost", port: "5432", username: "alice" }));
  assert.ok(!sameConnection(connection, { ...connection, username: "bob" }));
  assert.ok(!sameConnection(connection, { host: "localhost", port: "5432" }));
});
