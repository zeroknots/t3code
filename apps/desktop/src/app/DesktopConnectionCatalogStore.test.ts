import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
function layerSafeStorageFor(available: boolean, failDecrypt: Ref.Ref<boolean> | null = null) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
  options: {
    readonly declarationPath?: string;
    readonly safeStorageLayer?: Layer.Layer<ElectronSafeStorage.ElectronSafeStorage>;
  } = {},
) {
  const layerConfig = DesktopConfig.layerTest({
    T3CODE_HOME: baseDir,
    T3CODE_DECLARED_ENVIRONMENTS: options.declarationPath,
  });
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, layerConfig)));
  const layerSafeStorage =
    options.safeStorageLayer ?? layerSafeStorageFor(encryptionAvailable, failDecrypt);
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    NodeServices.layer,
    NodeCrypto.layer,
    fileSystemLayer,
  );
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
    Layer.provide(layerConfig),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** Use disposable public declarations and synthetic private runtime files only. */
const declarationFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-declared-store-test-" });
  const token = path.join(baseDir, "token");
  const declarationPath = path.join(baseDir, "declarations.json");
  yield* fileSystem.writeFileString(token, "synthetic-session\n");
  yield* fileSystem.chmod(token, 0o600);
  const entry = {
    environmentId: "remote-id",
    label: "Remote",
    url: "https://remote.example.test",
    bearerTokenFile: token,
  };
  const write = (environments: readonly unknown[] = [entry]) =>
    fileSystem.writeFileString(declarationPath, JSON.stringify({ schemaVersion: 1, environments }));
  yield* write();
  return {
    baseDir,
    token,
    declarationPath,
    entry,
    write,
    catalogPath: path.join(baseDir, "userdata", "connection-catalog.json"),
  };
});

describe("DesktopConnectionCatalogStore", () => {
  it.effect(
    "reconciles fresh declarations through encrypted atomic persistence and never rewrites unchanged state",
    () =>
      Effect.gen(function* () {
        const f = yield* declarationFixture;
        const fileSystem = yield* FileSystem.FileSystem;
        const writes = yield* Ref.make(0);
        const trackedFileSystem = Layer.succeed(FileSystem.FileSystem, {
          ...fileSystem,
          rename: (from, to) =>
            fileSystem.rename(from, to).pipe(Effect.tap(() => Ref.update(writes, (n) => n + 1))),
        });
        yield* Effect.gen(function* () {
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const first = yield* store.get;
          assert.isTrue(Option.isSome(first));
          const catalog = yield* decodeConnectionCatalog(Option.getOrThrow(first));
          assert.equal(catalog.profiles[0]?.connectionId, "nix:remote-id");
          const persisted = yield* fileSystem.readFileString(f.catalogPath);
          assert.notInclude(persisted, "synthetic-session");
          assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), [
            "encryptedCatalog",
            "version",
          ]);
          assert.equal(yield* Ref.get(writes), 1);
          assert.deepEqual(yield* store.get, first);
          assert.equal(yield* fileSystem.readFileString(f.catalogPath), persisted);
          assert.equal(yield* Ref.get(writes), 1);
          yield* f.write([]);
          assert.deepEqual(yield* store.get, first);
          assert.equal(yield* Ref.get(writes), 1);
        }).pipe(
          Effect.provide(
            layerFor(f.baseDir, true, null, trackedFileSystem, {
              declarationPath: f.declarationPath,
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stages legacy migration and every declaration before any persistent change", () =>
    Effect.gen(function* () {
      const f = yield* declarationFixture;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: [
              {
                environmentId: "legacy-id",
                label: "Legacy",
                httpBaseUrl: "https://legacy.example.test",
                wsBaseUrl: "wss://legacy.example.test",
                createdAt: "2026-06-03T00:00:00.000Z",
                lastConnectedAt: null,
                encryptedBearerToken: Base64.encode(textEncoder.encode("encrypted:legacy-session")),
              },
            ],
          }),
        );
        yield* f.write([
          f.entry,
          { ...f.entry, environmentId: "missing", bearerTokenFile: `${f.baseDir}/missing` },
        ]);
        const rejected = yield* store.get.pipe(Effect.flip);
        assert.equal(rejected._tag, "DesktopDeclaredEnvironmentsError");
        assert.isFalse(yield* fileSystem.exists(f.catalogPath));
        yield* f.write();
        const migrated = yield* store.get;
        const catalog = yield* decodeConnectionCatalog(Option.getOrThrow(migrated));
        assert.deepEqual(
          catalog.profiles.map((profile) => profile.connectionId),
          ["bearer:legacy-id", "nix:remote-id"],
        );
        assert.equal(catalog.credentials[0]?.credential.token, "legacy-session");
        const before = yield* fileSystem.readFileString(f.catalogPath);
        yield* fileSystem.writeFileString(f.token, "rotated-session");
        yield* f.write([
          f.entry,
          { ...f.entry, environmentId: "missing", bearerTokenFile: `${f.baseDir}/missing` },
        ]);
        yield* store.get.pipe(Effect.flip);
        assert.equal(yield* fileSystem.readFileString(f.catalogPath), before);
      }).pipe(
        Effect.provide(
          layerFor(f.baseDir, true, null, NodeServices.layer, {
            declarationPath: f.declarationPath,
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails closed without available encryption for both fresh and existing catalogs", () =>
    Effect.gen(function* () {
      const f = yield* declarationFixture;
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(
          layerFor(f.baseDir, false, null, NodeServices.layer, {
            declarationPath: f.declarationPath,
          }),
        ),
      );
      for (const existing of [false, true]) {
        if (existing) {
          yield* fileSystem.makeDirectory(`${f.baseDir}/userdata`, { recursive: true });
          yield* fileSystem.writeFileString(
            f.catalogPath,
            '{"version":1,"encryptedCatalog":"cHJlc2VydmU="}',
          );
        }
        const error = yield* store.get.pipe(Effect.flip);
        assert.equal(error._tag, "DesktopDeclaredEnvironmentsError");
        assert.notProperty(error, "cause");
        const secureStorage = yield* ElectronSafeStorage.ElectronSafeStorage.pipe(
          Effect.provide(layerSafeStorageFor(true)),
        );
        const checks = yield* Ref.make(0);
        const lockingStorage = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
          ...secureStorage,
          isEncryptionAvailable: Ref.getAndUpdate(checks, (n) => n + 1).pipe(
            Effect.map((n) => n === 0),
          ),
        });
        const lockingStore =
          yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
            Effect.provide(
              layerFor(f.baseDir, true, null, NodeServices.layer, {
                declarationPath: f.declarationPath,
                safeStorageLayer: lockingStorage,
              }),
            ),
          );
        const locked = yield* lockingStore.get.pipe(Effect.flip);
        assert.equal(locked._tag, "DesktopDeclaredEnvironmentsError");
        assert.equal(yield* fileSystem.exists(f.catalogPath), existing);
        if (existing)
          assert.equal(
            yield* fileSystem.readFileString(f.catalogPath),
            '{"version":1,"encryptedCatalog":"cHJlc2VydmU="}',
          );
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "sanitizes native schema and safeStorage failures without altering existing ciphertext",
    () =>
      Effect.gen(function* () {
        const f = yield* declarationFixture;
        const fileSystem = yield* FileSystem.FileSystem;
        const failDecrypt = yield* Ref.make(false);
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(
            layerFor(f.baseDir, true, failDecrypt, NodeServices.layer, {
              declarationPath: f.declarationPath,
            }),
          ),
        );
        yield* store.set(
          '{"schemaVersion":1,"targets":[],"credentials":[{"token":"synthetic-schema-secret"}]}',
        );
        const ciphertext = yield* fileSystem.readFileString(f.catalogPath);
        for (const decryptFailure of [false, true]) {
          yield* Ref.set(failDecrypt, decryptFailure);
          const error = yield* store.get.pipe(Effect.flip);
          assert.equal(error._tag, "DesktopDeclaredEnvironmentsError");
          assert.notProperty(error, "cause");
          assert.notInclude(JSON.stringify(error), "synthetic-schema-secret");
          assert.equal(yield* fileSystem.readFileString(f.catalogPath), ciphertext);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "keeps encryption and atomic replacement failures sanitized and never falls back to plaintext",
    () =>
      Effect.gen(function* () {
        const f = yield* declarationFixture;
        const fileSystem = yield* FileSystem.FileSystem;
        const secureStorage = yield* ElectronSafeStorage.ElectronSafeStorage.pipe(
          Effect.provide(layerSafeStorageFor(true)),
        );
        for (const failure of ["encryption", "rename"] as const) {
          const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
            ...secureStorage,
            encryptString:
              failure === "encryption"
                ? () =>
                    Effect.fail(
                      new ElectronSafeStorage.ElectronSafeStorageEncryptError({
                        cause: new Error("synthetic-private-encryption-failure"),
                      }),
                    )
                : secureStorage.encryptString,
          });
          const fileSystemLayer =
            failure === "rename"
              ? Layer.succeed(FileSystem.FileSystem, {
                  ...fileSystem,
                  rename: () =>
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        description: "synthetic-private-write-failure",
                      }),
                    ),
                })
              : NodeServices.layer;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
            Effect.provide(
              layerFor(f.baseDir, true, null, fileSystemLayer, {
                declarationPath: f.declarationPath,
                safeStorageLayer,
              }),
            ),
          );
          for (const existing of [false, true]) {
            let before: string | undefined;
            if (existing) {
              const seedStore =
                yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
                  Effect.provide(layerFor(f.baseDir)),
                );
              yield* seedStore.set(
                '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[]}',
              );
              before = yield* fileSystem.readFileString(f.catalogPath);
            }
            const error = yield* store.get.pipe(Effect.flip);
            assert.equal(error._tag, "DesktopDeclaredEnvironmentsError");
            assert.notProperty(error, "cause");
            assert.notInclude(JSON.stringify(error), "synthetic-private");
            assert.equal(yield* fileSystem.exists(f.catalogPath), existing);
            if (existing) assert.equal(yield* fileSystem.readFileString(f.catalogPath), before);
            const stateExists = yield* fileSystem.exists(`${f.baseDir}/userdata`);
            if (stateExists)
              assert.deepEqual(
                yield* fileSystem.readDirectory(`${f.baseDir}/userdata`),
                existing ? ["connection-catalog.json"] : [],
              );
            if (existing) yield* fileSystem.remove(f.catalogPath);
          }
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("persists and reads an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const records: readonly PersistedSavedEnvironmentRecord[] = [
          {
            environmentId: EnvironmentId.make("relay-environment"),
            label: "Relay",
            httpBaseUrl: "https://relay.example.com/",
            wsBaseUrl: "wss://relay.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
            relayManaged: { relayUrl: "https://relay-control.example.com/" },
          },
          {
            environmentId: EnvironmentId.make("ssh-environment"),
            label: "SSH",
            httpBaseUrl: "http://127.0.0.1:41773/",
            wsBaseUrl: "ws://127.0.0.1:41773/",
            createdAt: "2026-06-02T00:00:00.000Z",
            lastConnectedAt: null,
            desktopSsh: {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 22,
            },
          },
          {
            environmentId: EnvironmentId.make("bearer-environment"),
            label: "Bearer",
            httpBaseUrl: "https://bearer.example.com/",
            wsBaseUrl: "wss://bearer.example.com/",
            createdAt: "2026-06-03T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ];
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Base64.encode(
                      textEncoder.encode("encrypted:legacy-token"),
                    ),
                  }
                : record,
            ),
          }),
        );

        const migrated = yield* store.get;
        assert.isTrue(Option.isSome(migrated));
        if (Option.isNone(migrated)) {
          return;
        }
        const catalog = yield* decodeConnectionCatalog(migrated.value);

        assert.deepInclude(catalog.targets[0], {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make("relay-environment"),
          label: "Relay",
        });
        assert.deepInclude(catalog.targets[1], {
          _tag: "SshConnectionTarget",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          connectionId: "ssh:ssh-environment",
        });
        assert.deepInclude(catalog.targets[2], {
          _tag: "BearerConnectionTarget",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          connectionId: "bearer:bearer-environment",
        });
        assert.deepInclude(catalog.profiles[0], {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:ssh-environment",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 22,
          },
        });
        assert.deepInclude(catalog.profiles[1], {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:bearer-environment",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          httpBaseUrl: "https://bearer.example.com/",
          wsBaseUrl: "wss://bearer.example.com/",
        });
        assert.equal(catalog.credentials.length, 1);
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
        assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
        if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
          assert.equal(catalog.credentials[0].credential.token, "legacy-token");
        }

        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"version":1,"records":[]}',
        );
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const layer = layerFor(baseDir, true, failDecrypt);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );

      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      yield* Ref.set(failDecrypt, true);
      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
