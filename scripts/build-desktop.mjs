import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

await build({
  entryPoints: ["src/desktop/preload.ts"],
  bundle: true,
  external: ["electron"],
  format: "cjs",
  outfile: "dist/desktop/preload.cjs",
  platform: "node",
  target: "node22",
});

await build({
  entryPoints: ["src/desktop/renderer-entry.ts"],
  bundle: true,
  format: "iife",
  outfile: "dist/desktop/renderer-entry.js",
  platform: "browser",
  target: "chrome124",
});

const renderer = await import(
  new URL("../dist/desktop/renderer.js", import.meta.url).href
);
const shell = renderer.renderDesktopShell(
  renderer.createDesktopViewModel("loading"),
);
await writeFile(new URL("../dist/desktop/index.html", import.meta.url), shell);
