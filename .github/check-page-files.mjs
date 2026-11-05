// Every local script and stylesheet a page loads must be in the repo (run by .github/workflows/page-files.yml).
import fs from "node:fs";
const missing = new Map();
for (const page of fs.readdirSync(".").filter((f) => f.endsWith(".html"))) {
  const html = fs.readFileSync(page, "utf8");
  const refs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g), ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|\/\/|data:)/.test(ref)) continue;
    const file = ref.split(/[?#]/)[0].replace(/^\//, "");
    if (!fs.existsSync(file)) missing.set(file, (missing.get(file) || 0) + 1);
  }
}
if (missing.size) {
  for (const [f, n] of missing) console.log(`::error::${f} is loaded by ${n} page(s) but is not in the repo (add it, and to the .gitignore allowlist)`);
  process.exit(1);
}
console.log("All local scripts and stylesheets are present.");
