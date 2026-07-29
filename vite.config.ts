import { defineConfig } from "vite";
import { euclidParams } from "./build/euclidParams";

// Base "./" keeps built asset paths relative so the app can be hosted from a
// subfolder. The AudioWorklet lives in /public/worklet and is loaded by URL at
// runtime (see engineHost.ts), so it is served verbatim with no transform.
//
// euclidParams() generates its companion, worklet/engine-params.js, from the parameter
// registry in src/model/params.ts — the worklet's half of the snapshot contract, which
// used to be a hand-maintained mirror. It is virtual: middleware in dev, emitted at build.
export default defineConfig({
  base: "./",
  server: { host: true },
  plugins: [euclidParams()],
});
