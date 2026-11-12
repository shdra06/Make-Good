// Starts the API (port 4000) and the web app (port 3000) together.
// Open http://localhost:3000. Ctrl+C stops both.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run from the repository root wherever this is started from.
const root = fileURLToPath(new URL("..", import.meta.url));

const children = [
  ["api", ["run", "dev", "-w", "@makegood/api"]],
  ["web", ["run", "dev", "-w", "@makegood/web"]],
].map(([name, args]) => {
  // Links the API puts in customer emails point at the web app.
  const env = { ...process.env, PUBLIC_URL: process.env.PUBLIC_URL ?? "http://localhost:3000" };
  // A PORT set for the whole command is the web app's; the API always uses 4000 here.
  env.PORT = name === "api" ? "4000" : (process.env.PORT ?? "3000");
  const child = spawn(["npm", ...args].join(" "), { stdio: ["ignore", "pipe", "pipe"], shell: true, env, cwd: root });
  const prefix = (line) => `[${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line) console.log(prefix(line));
    });
  }
  child.on("exit", (code) => {
    console.log(prefix(`stopped (${code ?? "signal"})`));
    for (const other of children) if (other !== child) other.kill();
    process.exitCode = code ?? 0;
  });
  return child;
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => children.forEach((c) => c.kill()));
