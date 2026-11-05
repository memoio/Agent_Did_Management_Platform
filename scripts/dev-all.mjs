import { spawn } from "node:child_process";

const child = spawn("docker", ["compose", "up", "--build"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => { process.exitCode = code ?? 1; });
