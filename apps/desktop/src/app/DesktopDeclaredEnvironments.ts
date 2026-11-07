/*
 * MIT License
 * Copyright (c) 2026 zeroknots
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// @effect-diagnostics nodeBuiltinImport:off -- Native descriptor flags/UID checks are required at this UNIX security boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Redacted boundary failure: never retain inputs, credentials or lower-level diagnostic causes. */
export class DesktopDeclaredEnvironmentsError extends Schema.TaggedError<DesktopDeclaredEnvironmentsError>()(
  "DesktopDeclaredEnvironmentsError",
  {
    operation: Schema.Literals(["reconcile", "catalog-access", "encryption-unavailable"]),
  },
) {
  override get message(): string {
    return this.operation === "encryption-unavailable"
      ? "Declared environments require available Electron safeStorage encryption."
      : "Declared environments rejected. Check the public declaration schema, native catalog and private UNIX runtime token files; Windows is unsupported.";
  }
}

const Declaration = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      url: Schema.String,
      bearerTokenFile: Schema.String,
    }),
  ),
});
const decodeDeclaration = Schema.decodeUnknownSync(Declaration, { onExcessProperty: "error" });
const validateCatalog = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeSync(Json);
const encodeJson = Schema.encodeSync(Json);

/** Validation failures deliberately carry neither private inputs nor underlying diagnostics. */
function reject(): never {
  throw new DesktopDeclaredEnvironmentsError({ operation: "reconcile" });
}

/** Public identifiers and paths must be nonempty and free of hidden whitespace or controls. */
function text(value: string): string {
  if (!value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) reject();
  return value;
}

/** Accept only an origin; URL normalization must not erase a path, query or fragment. */
function endpoint(value: string) {
  text(value);
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (NodeNet.isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) reject();
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    reject();
  // Parsing also accepts /../, backslashes and empty ?/#, which are not origins.
  if (!/^https?:\/\/[^/?#\\@]+\/?$/i.test(value)) reject();
  return {
    httpBaseUrl: url.origin,
    wsBaseUrl: url.origin.replace(/^http/, "ws"),
  };
}

/** Test both lexical and resolved paths; secret files must never be immutable store artifacts. */
function outsideStore(filename: string): boolean {
  const normalized = NodePath.resolve(filename);
  return normalized !== "/nix/store" && !normalized.startsWith("/nix/store/");
}

/** Read through one bounded, nonblocking descriptor, allowing resolved runtime secret symlinks. */
async function readBounded(
  filename: string,
  maximum: number,
  privateToken: boolean,
): Promise<string> {
  text(filename);
  if (!NodePath.isAbsolute(filename) || (privateToken && !outsideStore(filename))) reject();
  const resolved = await NodeFSP.realpath(filename);
  if (privateToken && !outsideStore(resolved)) reject();
  const file = await NodeFSP.open(
    resolved,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) reject();
    if (
      privateToken &&
      (info.size < 1 ||
        (info.mode & 0o077) !== 0 ||
        (info.uid !== 0 && info.uid !== process.getuid!()))
    )
      reject();
    // Refuse a swapped link/path rather than inspecting one file and reading another.
    const current = await NodeFSP.realpath(filename);
    const currentInfo = await NodeFSP.stat(current);
    if (current !== resolved || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino)
      reject();
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maximum) reject();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    await file.close();
  }
}

/** Stage and validate all declarations before producing an additive native catalog; never write. */
export const mergeCatalog = Effect.fn("desktop.declaredEnvironments.mergeCatalog")(
  (serialized: string | null, filename: string, platform: NodeJS.Platform) =>
    Effect.tryPromise({
      try: async () => {
        // UNIX mode/UID checks are not a substitute for Windows ACL validation.
        if (platform === "win32" || typeof process.getuid !== "function") reject();
        const declaration = decodeDeclaration(
          decodeJson(await readBounded(filename, 1048576, false)),
        );
        const ids = new Set<string>();
        const staged = declaration.environments.map((entry) => {
          const environmentId = entry.environmentId;
          text(environmentId);
          const label = text(entry.label);
          if (ids.has(environmentId)) reject();
          ids.add(environmentId);
          return {
            ...entry,
            environmentId,
            label,
            connectionId: `nix:${environmentId}`,
            ...endpoint(entry.url),
          };
        });
        const tokens: string[] = [];
        for (const entry of staged) {
          const token = (await readBounded(entry.bearerTokenFile, 65536, true)).trim();
          if (!token || /\s|[\x00-\x1f\x7f]/.test(token)) reject();
          tokens.push(token);
        }
        const raw: unknown =
          serialized === null
            ? structuredClone(EMPTY_CONNECTION_CATALOG_DOCUMENT)
            : decodeJson(serialized);
        validateCatalog(raw);
        // Use the validated original, not the decoder's output, which strips unknown fields.
        const document = raw as typeof ConnectionCatalogDocument.Encoded;
        const targets = [...document.targets];
        const profiles = [...document.profiles];
        const credentials = [...document.credentials];
        for (const [index, entry] of staged.entries()) {
          const { environmentId, label, connectionId, httpBaseUrl, wsBaseUrl } = entry;
          const target = new BearerConnectionTarget({ environmentId, label, connectionId });
          const profile = new BearerConnectionProfile({
            environmentId,
            label,
            connectionId,
            httpBaseUrl,
            wsBaseUrl,
          });
          const credential = {
            connectionId,
            credential: { _tag: "BearerConnectionCredential" as const, token: tokens[index]! },
          };
          // The stable nix: namespace cannot convert SSH/relay routes or overwrite another environment.
          for (const values of [document.targets, document.profiles]) {
            const matches = values.filter(
              (value) => "connectionId" in value && value.connectionId === connectionId,
            );
            if (
              matches.length > 1 ||
              matches.some(
                (value) =>
                  value.environmentId !== environmentId ||
                  (value._tag !== "BearerConnectionTarget" &&
                    value._tag !== "BearerConnectionProfile"),
              )
            )
              reject();
          }
          if (credentials.filter((value) => value.connectionId === connectionId).length > 1)
            reject();
          const targetIndex = targets.findIndex(
            (value) => "connectionId" in value && value.connectionId === connectionId,
          );
          const profileIndex = profiles.findIndex((value) => value.connectionId === connectionId);
          const credentialIndex = credentials.findIndex(
            (value) => value.connectionId === connectionId,
          );
          if (targetIndex < 0) targets.push(target);
          else targets[targetIndex] = { ...targets[targetIndex], ...target };
          if (profileIndex < 0) profiles.push(profile);
          else profiles[profileIndex] = { ...profiles[profileIndex], ...profile };
          if (credentialIndex < 0) credentials.push(credential);
          else
            credentials[credentialIndex] = {
              ...credentials[credentialIndex]!,
              credential: { ...credentials[credentialIndex]!.credential, ...credential.credential },
            };
        }
        const next = { ...document, targets, profiles, credentials };
        validateCatalog(next);
        const encoded = encodeJson(next);
        // Removal is not revocation; unchanged documents keep their exact bytes and ciphertext.
        return serialized !== null && encodeJson(raw) === encoded ? serialized : encoded;
      },
      catch: () => new DesktopDeclaredEnvironmentsError({ operation: "reconcile" }),
    }),
);
