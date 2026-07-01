import { defineConfig } from "vite";

// Base "./" keeps built asset paths relative so the app can be hosted from a
// subfolder. The AudioWorklet lives in /public/worklet and is loaded by URL at
// runtime (see engineHost.ts), so it is served verbatim with no transform.
export default defineConfig({
  base: "./",
  server: { host: true },
});
