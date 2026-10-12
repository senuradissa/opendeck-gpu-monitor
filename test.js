const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

// 1. Start the sampler as a long-running child process
const ps = spawn("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-File", path.join(__dirname, "gpu-sampler.ps1"),
], { windowsHide: true });

// 2. Read its stdout line by line and keep the newest sample
let latest = null;
readline.createInterface({ input: ps.stdout }).on("line", (line) => {
  try {
    const s = JSON.parse(line);
    latest = {
      load: Math.min(100, Math.max(0, s.load)), // clamp to 0–100
      vramMB: s.vramMB,
      at: Date.now(),                           // when we received it
    };
  } catch {
    // ignore anything that isn't a JSON line
  }
});

ps.stderr.on("data", (d) => console.error("[sampler]", d.toString().trim()));
ps.on("exit", (code) => console.error(`sampler exited (code ${code})`));

// 3. Print the latest value once a second
setInterval(() => {
  if (!latest) return console.log("waiting for first sample...");
  const age = ((Date.now() - latest.at) / 1000).toFixed(1);
  console.log(`GPU ${latest.load.toFixed(1)}%  VRAM ${latest.vramMB} MB  (${age}s old)`);
}, 1000);

// 4. Don't leave an orphaned PowerShell behind
function cleanup() { ps.kill(); }
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });