import { build } from "esbuild";

await build({
  entryPoints: ["src/desktop/preload.ts"],
  bundle: true,
  external: ["electron"],
  format: "cjs",
  outfile: "dist/desktop/preload.cjs",
  platform: "node",
  target: "node22",
});
