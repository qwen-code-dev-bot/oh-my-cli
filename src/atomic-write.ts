import fs from "node:fs";
import path from "node:path";

// Persist UTF-8 content to an absolute path atomically via the repository's
// established temp-file + rename pattern (#506). A crash or ENOSPC inside the
// write can never leave a half-written file: the previous content survives
// untouched and the temp file is cleaned up. When the target already exists
// its mode is preserved so editing never silently drops permission bits
// (executable scripts stay executable).
export function atomicWriteFile(absTarget: string, content: string): void {
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(absTarget).mode;
  } catch {
    mode = undefined; // new file: default permissions apply
  }
  const tmp = `${absTarget}.oh-my-cli-${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      content,
      mode === undefined ? { encoding: "utf-8" } : { encoding: "utf-8", mode },
    );
    fs.renameSync(tmp, absTarget);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
