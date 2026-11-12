// Production start: one server, one public address.
//   - the API listens privately on API_PORT (default 4001), with its job worker;
//   - the Next.js app listens on PORT and passes /api/* to the API.
// If either process stops, the other is stopped too, so the host restarts both.
// Run `npm run build` first.

import { spawn } from "node:child_process";

const webPort = process.env.PORT ?? "3000";
const apiPort = process.env.API_PORT ?? "4001";

const run = (name, command, args, env, shell = false) => {
  // On Windows npm is a .cmd file and needs a shell; the command is then passed as one string.
  const child = shell
    ? spawn([command, ...args].join(" "), { stdio: "inherit", env: { ...process.env, ...env }, shell: true })
    : spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
  child.on("exit", (code, signal) => {
    console.error(`[${name}] exited (${code ?? signal}); stopping`);
    for (const c of children) if (c !== child && c.exitCode === null) c.kill("SIGTERM");
    process.exitCode = code ?? 1;
  });
  return child;
};

const children = [
  run("api", process.execPath, ["apps/api/src/server.ts"], { PORT: apiPort }),
  run("web", "npm", ["run", "start", "-w", "@makegood/web", "--", "-p", webPort], { API_URL: `http://127.0.0.1:${apiPort}` }, process.platform === "win32"),
];

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => children.forEach((c) => c.kill(signal)));
