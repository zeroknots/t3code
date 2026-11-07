// @effect-diagnostics nodeBuiltinImport:off -- Exercise real descriptor permissions, symlinks and FIFOs at the native boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { mergeCatalog } from "./DesktopDeclaredEnvironments.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFSP>()),
}));

/** Keep declarations and synthetic credentials isolated, including cleanup after assertion failures. */
const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-declarations-test-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const token = NodePath.join(directory, "token");
  const file = NodePath.join(directory, "declarations.json");
  yield* Effect.promise(() => NodeFSP.writeFile(token, "synthetic-session\n", { mode: 0o600 }));
  const entry = {
    environmentId: "remote-id",
    label: "Remote",
    url: "https://remote.example.test",
    bearerTokenFile: token,
  };
  const write = (environments: readonly unknown[] = [entry]) =>
    Effect.promise(() =>
      NodeFSP.writeFile(file, JSON.stringify({ schemaVersion: 1, environments })),
    );
  yield* write();
  return { directory, token, file, entry, write };
});

/** Assert the full diagnostic, not only its message, cannot retain private inputs. */
const rejected = Effect.fn("test.declarations.rejected")(function* (
  catalog: string | null,
  filename: string,
  platform: NodeJS.Platform = "linux",
) {
  const error = yield* mergeCatalog(catalog, filename, platform).pipe(Effect.flip);
  expect(error._tag).toBe("DesktopDeclaredEnvironmentsError");
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toMatch(/synthetic|bearerTokenFile|remote\.example|\/tmp\//);
});

describe("DesktopDeclaredEnvironments", () => {
  it.effect(
    "creates native records, rotates only owned values, preserves unknown fields and original unchanged bytes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const initial = JSON.parse(yield* mergeCatalog(null, f.file, "linux"));
        expect(initial.targets).toEqual([
          {
            _tag: "BearerConnectionTarget",
            environmentId: "remote-id",
            label: "Remote",
            connectionId: "nix:remote-id",
          },
        ]);
        expect(initial.profiles[0]).toMatchObject({
          httpBaseUrl: f.entry.url,
          wsBaseUrl: "wss://remote.example.test",
        });
        expect(initial.credentials[0].credential).toEqual({
          _tag: "BearerConnectionCredential",
          token: "synthetic-session",
        });
        initial.targets.unshift({
          _tag: "RelayConnectionTarget",
          environmentId: "remote-id",
          label: "Manual relay",
        });
        initial.profiles.push({
          ...initial.profiles[0],
          connectionId: "manual",
          environmentId: "other",
        });
        initial.credentials.push({
          connectionId: "manual",
          credential: { _tag: "BearerConnectionCredential", token: "manual-session" },
        });
        initial.disabledEnvironmentIds = ["remote-id"];
        initial.githubRoutingPermissions = [
          { environmentId: "other", connectionKey: "manual", permission: "read" },
        ];
        initial.remoteDpopTokens = [
          {
            environmentId: "other",
            label: "Manual",
            accessToken: "manual-dpop-session",
            expiresAtEpochMs: 2000000000000,
            dpopThumbprint: "manual-thumbprint",
            endpoint: {
              httpBaseUrl: "https://manual.example.test",
              wsBaseUrl: "wss://manual.example.test",
              providerKind: "manual",
            },
          },
        ];
        initial.futureField = { keep: true };
        initial.targets[1].futureTargetField = "keep";
        initial.profiles[0].futureProfileField = "keep";
        initial.credentials[0].futureRecordField = "keep";
        initial.credentials[0].credential.futureCredentialField = "keep";
        const pretty = JSON.stringify(initial, null, 2);
        expect(yield* mergeCatalog(pretty, f.file, "linux")).toBe(pretty);
        yield* Effect.promise(() => NodeFSP.writeFile(f.token, "rotated-session"));
        f.entry.url = "https://replacement.example.test/";
        f.entry.label = "Renamed";
        yield* f.write();
        const updated = JSON.parse(yield* mergeCatalog(pretty, f.file, "linux"));
        expect(updated.targets[0]).toEqual(initial.targets[0]);
        expect(updated.targets[1]).toMatchObject({ label: "Renamed", futureTargetField: "keep" });
        expect(updated.profiles[0]).toMatchObject({
          httpBaseUrl: "https://replacement.example.test",
          futureProfileField: "keep",
        });
        expect(updated.profiles[1]).toEqual(initial.profiles[1]);
        expect(updated.credentials[1]).toEqual(initial.credentials[1]);
        expect(updated.credentials[0].futureRecordField).toBe("keep");
        expect(updated.credentials[0].credential).toMatchObject({
          token: "rotated-session",
          futureCredentialField: "keep",
        });
        expect(updated.disabledEnvironmentIds).toEqual(initial.disabledEnvironmentIds);
        expect(updated.futureField).toEqual(initial.futureField);
        expect(updated.githubRoutingPermissions).toEqual(initial.githubRoutingPermissions);
        expect(updated.remoteDpopTokens).toEqual(initial.remoteDpopTokens);
        const serialized = JSON.stringify(updated);
        yield* f.write([]);
        expect(yield* mergeCatalog(serialized, f.file, "linux")).toBe(serialized);
        expect(yield* Effect.promise(() => NodeFSP.readFile(f.token, "utf8"))).toBe(
          "rotated-session",
        );
      }),
  );

  it.effect.each([
    "http://remote.example.test",
    "http://127.evil.test",
    "file:///tmp/token",
    "not a URL",
    "https://user:synthetic-password@remote.example.test",
    "https://remote.example.test?synthetic-query",
    "https://remote.example.test#synthetic-fragment",
    "https://remote.example.test/prefix",
    "https://remote.example.test/../",
    "https://remote.example.test?",
    "https://remote.example.test#",
  ])("rejects unsafe or non-origin URL %s", (url) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([{ ...f.entry, url }]);
      yield* rejected(null, f.file);
    }),
  );

  it.effect.each([
    "http://127.0.0.1:3773",
    "http://127.0.0.2",
    "http://localhost:3773",
    "http://[::1]:3773",
    "https://remote.example.test:8443/",
    "HTTPS://REMOTE.EXAMPLE.TEST:443/",
  ])("accepts secure origins and loopback %s", (url) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write([{ ...f.entry, url }]);
      const catalog = JSON.parse(yield* mergeCatalog(null, f.file, "linux"));
      expect(catalog.profiles[0].httpBaseUrl).toBe(new URL(url).origin);
    }),
  );

  it.effect.each([0o644, 0o640, 0o604, 0o660, 0o777])("rejects nonprivate token modes %s", (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(() => NodeFSP.chmod(f.token, mode));
      yield* rejected(null, f.file);
    }),
  );

  it.effect.each([
    { name: "empty", content: "" },
    { name: "blank", content: " \n" },
    { name: "whitespace", content: "two tokens" },
    { name: "header injection", content: "synthetic-token\r\nInjected: header" },
    { name: "control", content: "synthetic\u0000token" },
    { name: "oversized", content: "x".repeat(65537) },
  ])("rejects invalid token content ($name)", ({ content }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(() => NodeFSP.writeFile(f.token, content));
      yield* rejected(null, f.file);
    }),
  );

  it.effect(
    "allows private token size boundary and runtime symlinks but rejects FIFO, directories and store paths",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const link = NodePath.join(f.directory, "runtime-link");
        yield* Effect.promise(() => NodeFSP.symlink(f.token, link));
        yield* f.write([{ ...f.entry, bearerTokenFile: link }]);
        yield* Effect.promise(() => NodeFSP.writeFile(f.token, "x".repeat(65536)));
        expect(
          JSON.parse(yield* mergeCatalog(null, f.file, "linux")).credentials[0].credential.token,
        ).toHaveLength(65536);
        const fifo = NodePath.join(f.directory, "fifo");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        for (const bearerTokenFile of [
          fifo,
          f.directory,
          "relative",
          "/nix/store",
          "/nix/store/synthetic-token",
          "/nix/../nix/store/synthetic-token",
        ]) {
          yield* f.write([{ ...f.entry, bearerTokenFile }]);
          yield* rejected(null, f.file);
        }
        yield* Effect.promise(() => NodeFSP.unlink(f.file));
        NodeChildProcess.execFileSync("mkfifo", [f.file]);
        yield* rejected(null, f.file);
      }),
  );

  it.effect("rejects a symlink resolved into the store before opening the secret", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      using _resolved = vi
        .spyOn(NodeFSP, "realpath")
        .mockResolvedValueOnce(f.file)
        .mockResolvedValueOnce(f.file)
        .mockResolvedValueOnce("/nix/store/synthetic-token");
      using open = vi.spyOn(NodeFSP, "open");
      yield* rejected(null, f.file);
      expect(open.mock.calls.some(([filename]) => filename === "/nix/store/synthetic-token")).toBe(
        false,
      );
    }),
  );

  it.effect(
    "accepts root ownership, rejects a foreign UID and fails closed on Windows before reading",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const nativeOpen = NodeFSP.open;
        for (const uid of [0, 4294967294]) {
          using _owner = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
            const file = await nativeOpen(...args);
            if (args[0] === f.token) {
              const info = await file.stat();
              info.uid = uid;
              vi.spyOn(file, "stat").mockResolvedValue(info);
            }
            return file;
          });
          if (uid === 0)
            expect(JSON.parse(yield* mergeCatalog(null, f.file, "linux")).credentials).toHaveLength(
              1,
            );
          else yield* rejected(null, f.file);
        }
        using open = vi.spyOn(NodeFSP, "open");
        open.mockClear();
        yield* rejected(null, f.file, "win32");
        expect(open).not.toHaveBeenCalled();
      }),
  );

  it.effect("rejects duplicate IDs, inline secrets and malformed or oversized public JSON", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const entries of [
        [f.entry, f.entry],
        [{ ...f.entry, token: "synthetic-inline-secret" }],
        [{ ...f.entry, environmentId: " " }],
      ]) {
        yield* f.write(entries);
        yield* rejected(null, f.file);
      }
      for (const raw of [
        "{synthetic-json",
        "null",
        '{"schemaVersion":2,"environments":[]}',
        '{"schemaVersion":1,"environments":"synthetic"}',
        " ".repeat(1048577),
      ]) {
        yield* Effect.promise(() => NodeFSP.writeFile(f.file, raw));
        yield* rejected(null, f.file);
      }
    }),
  );

  it.effect("rejects malformed native catalogs and ambiguous or conflicting owned IDs", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = JSON.parse(yield* mergeCatalog(null, f.file, "linux"));
      for (const raw of [
        "synthetic-not-json",
        "null",
        '{"schemaVersion":2}',
        JSON.stringify({ ...first, profiles: [{ token: "synthetic-schema-value" }] }),
      ])
        yield* rejected(raw, f.file);
      for (const key of ["targets", "profiles", "credentials"]) {
        const duplicate = structuredClone(first);
        duplicate[key].push(structuredClone(duplicate[key][0]));
        yield* rejected(JSON.stringify(duplicate), f.file);
      }
      for (const key of ["targets", "profiles"]) {
        const collision = structuredClone(first);
        collision[key][0].environmentId = "other";
        yield* rejected(JSON.stringify(collision), f.file);
      }
      const ssh = structuredClone(first);
      ssh.targets[0]._tag = "SshConnectionTarget";
      yield* rejected(JSON.stringify(ssh), f.file);
    }),
  );

  it.effect("stages every declaration before returning a changed catalog", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* mergeCatalog(null, f.file, "linux");
      yield* Effect.promise(() => NodeFSP.writeFile(f.token, "rotated-session"));
      yield* f.write([
        f.entry,
        {
          ...f.entry,
          environmentId: "later",
          bearerTokenFile: NodePath.join(f.directory, "synthetic-missing"),
        },
      ]);
      yield* rejected(first, f.file);
      expect(JSON.parse(first).credentials[0].credential.token).toBe("synthetic-session");
      expect((yield* Effect.promise(() => NodeFSP.readdir(f.directory))).sort()).toEqual([
        "declarations.json",
        "token",
      ]);
    }),
  );
});
