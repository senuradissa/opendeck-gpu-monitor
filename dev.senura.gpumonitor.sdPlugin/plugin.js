"use strict";
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

// ---- settings you might tweak ----
const VRAM_TOTAL_MB = 4096; // your card's dedicated memory (Task Manager > GPU > "Dedicated GPU memory")
const FRAME_MS = 100;       // redraw rate while animating
const HISTORY = 60;         // sparkline length (samples ~ seconds)

// Per-view config: label, scale, warning thresholds, how to format the number
const VIEWS = {
  load: { label: "GPU",  min: 0,  max: 100,           warn: 60,                  crit: 85,                  unit: "%",
          fmt: (v) => Math.round(v).toString() },
  vram: { label: "VRAM", min: 0,  max: VRAM_TOTAL_MB, warn: VRAM_TOTAL_MB * 0.75, crit: VRAM_TOTAL_MB * 0.9, unit: "GB",
          fmt: (v) => (v / 1024).toFixed(2) },
  temp: { label: "TEMP", min: 30, max: 90,            warn: 70,                  crit: 80,                  unit: "&#176;C",
          fmt: (v) => Math.round(v).toString() },
};
const MODES = Object.keys(VIEWS);

// ---- 1. launch arguments ----
const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^-+/, "")] = process.argv[i + 1];

// ---- data: latest sample + history for sparklines ----
let latest = null;
const hist = { load: [], vram: [], temp: [] };

function ingest(s) {
  latest = {
    load: Math.min(100, Math.max(0, s.load)),
    vram: s.vramMB,
    temp: typeof s.temp === "number" ? s.temp : null, // null = driver didn't report it
    at: Date.now(),
  };
  for (const m of MODES) {
    if (latest[m] === null) continue;
    hist[m].push(latest[m]);
    if (hist[m].length > HISTORY) hist[m].shift();
  }
}

// ---- drawing helpers ----
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const frac = (view, v) => clamp01((v - view.min) / (view.max - view.min));

function colorFor(view, v) {
  if (v >= view.crit) return "#ff5c5c"; // red
  if (v >= view.warn) return "#ffb547"; // amber
  return "#3ddc97";                     // green
}

// Ring geometry: 270-degree arc with the gap at the bottom
const CX = 72, CY = 62, R = 48;
const CIRC = 2 * Math.PI * R;
const ARC = CIRC * 0.75;

function sparkline(view, values, color) {
  if (values.length < 2) return "";
  const x0 = 14, x1 = 130, y0 = 138, y1 = 120; // box: bottom y0, top y1
  const step = (x1 - x0) / (HISTORY - 1);
  const start = x1 - step * (values.length - 1); // newest sample on the right
  const pts = values.map((v, i) =>
    `${(start + i * step).toFixed(1)},${(y0 - frac(view, v) * (y0 - y1)).toFixed(1)}`);
  const area = `${start.toFixed(1)},${y0} ${pts.join(" ")} ${x1},${y0}`;
  return `<polygon points="${area}" fill="${color}" opacity="0.18"/>
  <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function render(mode, shown) {
  const view = VIEWS[mode];
  const stale = !latest || Date.now() - latest.at > 5000;
  const value = stale ? null : latest[mode];
  const ok = value !== null;

  const color = ok ? colorFor(view, value) : "#555b66";
  const arcLen = ok ? frac(view, shown) * ARC : 0;
  const big = stale ? "--" : ok ? view.fmt(value) : "n/a";
  const unit = ok ? view.unit : stale ? "no data" : "";
  const bigSize = big.length > 3 ? 27 : 32; // shrink "3.21" so it clears the ring

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="#0e1116"/>
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#232833" stroke-width="10"
    stroke-linecap="round" stroke-dasharray="${ARC.toFixed(2)} ${CIRC.toFixed(2)}" transform="rotate(135 ${CX} ${CY})"/>
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}" stroke-width="10"
    stroke-linecap="round" stroke-dasharray="${arcLen.toFixed(2)} ${CIRC.toFixed(2)}" transform="rotate(135 ${CX} ${CY})"
    opacity="${arcLen > 0.5 ? 1 : 0}"/>
  <text x="${CX}" y="${CY + 8}" font-family="Segoe UI, sans-serif" font-size="${bigSize}" font-weight="700"
    fill="#f2f4f8" text-anchor="middle">${big}</text>
  <text x="${CX}" y="${CY + 26}" font-family="Segoe UI, sans-serif" font-size="13" fill="#8a93a3" text-anchor="middle">${unit}</text>
  <text x="${CX}" y="${CY + R + 2}" font-family="Segoe UI, sans-serif" font-size="12" font-weight="600"
    letter-spacing="1.5" fill="${color}" text-anchor="middle">${view.label}</text>
  ${sparkline(view, hist[mode], color)}
</svg>`;
}

// ---- preview mode: node plugin.js --preview <outdir> (no OpenDeck, fake data) ----
if (args.preview) {
  fs.mkdirSync(args.preview, { recursive: true });
  for (let i = 0; i < HISTORY; i++)
    ingest({ load: 30 + 25 * Math.sin(i / 6) + Math.random() * 10, vramMB: 2400 + i * 15, temp: 55 + i / 3 });
  for (const m of MODES)
    fs.writeFileSync(path.join(args.preview, `${m}.svg`), render(m, latest[m]));
  latest.at = 0;
  fs.writeFileSync(path.join(args.preview, "stale.svg"), render("load", 0));
  process.exit(0);
}

// ---- sampler ----
const ps = spawn("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-File", path.join(__dirname, "gpu-sampler.ps1"),
], { windowsHide: true });

readline.createInterface({ input: ps.stdout }).on("line", (line) => {
  try { ingest(JSON.parse(line)); } catch {}
});

function cleanup() { ps.kill(); }
process.on("exit", cleanup);

// ---- 2. connect + register ----
let ws;
const keys = new Map(); // context -> { mode, shown, lastSvg }

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
  ws.onopen = () => send({ event: args.registerEvent, uuid: args.pluginUUID });
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => process.exit(0); // OpenDeck closed: exit (and kill sampler)
}

// ---- 3. events in ----
function onMessage({ event, context, payload }) {
  if (event === "willAppear") {
    const saved = payload?.settings?.mode;
    keys.set(context, { mode: MODES.includes(saved) ? saved : "load", shown: null, lastSvg: "" });
  } else if (event === "willDisappear") {
    keys.delete(context);
  } else if (event === "keyUp") {
    const k = keys.get(context);
    if (!k) return;
    k.mode = MODES[(MODES.indexOf(k.mode) + 1) % MODES.length]; // cycle
    k.shown = null; // sweep the ring up from empty for the new view
    send({ event: "setSettings", context, payload: { mode: k.mode } }); // remember it
  }
}

// ---- 4. images out (animated) ----
function frame() {
  for (const [context, k] of keys) {
    const view = VIEWS[k.mode];
    const target = latest && latest[k.mode] !== null ? latest[k.mode] : view.min;
    if (k.shown === null) k.shown = view.min;
    k.shown += (target - k.shown) * 0.25;                  // ease toward the real value
    if (Math.abs(target - k.shown) < 0.01 * (view.max - view.min)) k.shown = target;

    const svg = render(k.mode, k.shown);
    if (svg === k.lastSvg) continue;                       // nothing changed: don't resend
    k.lastSvg = svg;
    send({ event: "setImage", context, payload: {
      image: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"), target: 0 } });
  }
}

connect();
setInterval(frame, FRAME_MS);