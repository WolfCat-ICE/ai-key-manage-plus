import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const distDir = join(root, "dist");
const standaloneDir = join(distDir, "standalone");
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");

function runNextBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, "build"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
      },
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`next build failed with code ${code ?? "null"} and signal ${signal ?? "null"}`));
    });
  });
}

async function copyIfExists(from, to) {
  if (!existsSync(from)) return;
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}

await runNextBuild();
await copyIfExists(join(root, "public"), join(standaloneDir, "public"));
await copyIfExists(join(distDir, "static"), join(standaloneDir, "dist", "static"));
await copyIfExists(
  join(root, "node_modules", "sql.js", "dist"),
  join(standaloneDir, "node_modules", "sql.js", "dist")
);

console.log("Standalone deployment package is ready at dist/standalone");
