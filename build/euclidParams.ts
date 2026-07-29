// The generator that carries the snapshot contract across into the AudioWorklet.
//
// src/model/params.ts is the single source: it owns ParamId, every parameter's spec, and
// what each discrete choice INDEX means to the DSP. This plugin emits those facts as
// public/worklet/engine-params.js, which engine.js reads at the top. Nothing is retyped by
// hand on the worklet side any more.
//
// Why a second file rather than an import: an AudioWorklet module cannot use `import` on
// iOS Safari, and this app targets iOS. Every script passed to addModule on a context runs
// in the SAME AudioWorkletGlobalScope, in order — so engine-params.js publishes onto
// globalThis and engine.js reads it back (see EngineHost.start).
//
// The file is VIRTUAL: served by middleware in dev, emitted into dist at build. Nothing
// lands on disk, so a stale copy cannot exist and there is nothing to gitignore.
//
// Two checks guard the seam:
//   - at build, every table engine.js asks for via need("X") must be one this file emits;
//   - at runtime, EngineHost compares STAMP against the value compiled into the bundle,
//     which catches an offline client pairing a cached params file with a newer engine.js.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { ENGINE_TABLES } from "../src/model/params";

/** Where the worklet's two files live, relative to dist / the dev server root. */
const PARAMS_PATH = "worklet/engine-params.js";
const ENGINE_PATH = "worklet/engine.js";

/** A short content hash, used only to notice that two files came from different builds.
    FNV-1a — no crypto import, and collisions here would merely miss a warning. */
function stampOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** THE BUILD CHECK. Every table engine.js pulls out of the generated object must be one
    the registry emits. `need("X")` is both the read and the declaration — one mechanism, so
    a table cannot be used on the DSP side without being declared here. */
export function assertEngineNeeds(root: string): void {
  const src = readFileSync(resolve(root, "public", ENGINE_PATH), "utf8");
  const missing = new Set<string>();
  for (const m of src.matchAll(/\bneed\("([A-Za-z_][A-Za-z0-9_]*)"\)/g)) {
    if (!(m[1] in ENGINE_TABLES)) missing.add(m[1]);
  }
  if (missing.size) {
    throw new Error(
      `[euclid-params] engine.js asks for ${[...missing].map((m) => `need("${m}")`).join(", ")}, ` +
      `which src/model/params.ts does not emit. Add it to ENGINE_TABLES (or fix the spelling).`,
    );
  }
}

/** The generated file's text, plus the stamp EngineHost checks against. Pure: no file
    system, so it is safe to call from the config hook before the root is resolved. */
export function emitEngineParams(): { code: string; stamp: string } {
  const payload = JSON.stringify(ENGINE_TABLES, null, 2);
  const stamp = stampOf(payload);
  const code = `// GENERATED FILE — do not edit.
// Emitted from src/model/params.ts by build/euclidParams.ts. Runs in the
// AudioWorkletGlobalScope BEFORE engine.js, which reads these tables back off globalThis.
globalThis.EUCLID_PARAMS = Object.freeze(${payload});
globalThis.EUCLID_PARAMS_STAMP = ${JSON.stringify(stamp)};
`;
  return { code, stamp };
}

export function euclidParams(): Plugin {
  return {
    name: "euclid-params",

    // The stamp the main thread expects. EngineHost compares it against the one the
    // worklet actually loaded, so a cached-but-stale params file is reported, not ignored.
    config() {
      return { define: { __EUCLID_PARAMS_STAMP__: JSON.stringify(emitEngineParams().stamp) } };
    },

    // Run the build check as soon as the project root is known — dev and build alike, so a
    // table engine.js needs but the registry doesn't emit fails immediately either way.
    configResolved(config) {
      assertEngineNeeds(config.root);
    },

    // Dev: answer the worklet's fetch from memory. Regenerated per request, so editing
    // params.ts and reloading is enough — no restart, no file to clean up.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.split("?")[0].endsWith(PARAMS_PATH)) return next();
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(emitEngineParams().code);
      });
      // The worklet only reads its tables at addModule time, so a param change needs a
      // full reload rather than an HMR patch.
      server.watcher.on("change", (file) => {
        if (file.replace(/\\/g, "/").endsWith("src/model/params.ts")) {
          server.ws.send({ type: "full-reload", path: "*" });
        }
      });
    },

    // Build: emit alongside the copied-over public/ assets. Unhashed on purpose — the
    // service worker serves everything under /worklet/ network-first (see public/sw.js).
    generateBundle() {
      this.emitFile({ type: "asset", fileName: PARAMS_PATH, source: emitEngineParams().code });
    },
  };
}
