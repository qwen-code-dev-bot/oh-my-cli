import path from "node:path";
import fs from "node:fs";

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new Error(`Path escape rejected: ${relativePath}`);
    }
    return resolved;
  }

  resolveSafe(relativePath: string): string {
    const resolved = this.resolve(relativePath);
    // Check for symlink escape: walk each ancestor that exists
    let current = resolved;
    while (current.length > this.root.length) {
      if (fs.existsSync(current)) {
        const real = fs.realpathSync(current);
        if (!real.startsWith(this.root + path.sep) && real !== this.root) {
          throw new Error(`Symlink path escape rejected: ${relativePath}`);
        }
      }
      current = path.dirname(current);
    }
    return resolved;
  }
}
