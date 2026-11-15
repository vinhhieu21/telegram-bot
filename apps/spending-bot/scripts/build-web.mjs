// Builds the Mini App page (web/) into dist/web/, which wrangler serves as static assets.
// Runs before `wrangler dev`/`deploy` ([build] in wrangler.toml) and before the tests.
//
// The script and stylesheet get a content hash in their names, so Telegram's webviews, which
// cache hard, always load the version index.html asks for. index.html itself is never cached (_headers).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "web");
const out = join(root, "dist", "web");
// Built beside `out` and swapped in, so `wrangler dev` (which rebuilds on change) never serves a
// half-written directory, even while another build (e.g. `npm test`) runs at the same time.
const tmp = `${out}.${process.pid}.tmp`;
const app = join(tmp, "app");

const bundle = await build({
  entryPoints: [join(src, "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022", // iOS 16+ / Android System WebView 100+
  minify: true,
  legalComments: "none",
  write: false,
});
const js = bundle.outputFiles[0].text;
const css = readFileSync(join(src, "style.css"), "utf8");

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 10);
const jsName = `main.${hash(js)}.js`;
const cssName = `style.${hash(css)}.css`;
const html = readFileSync(join(src, "index.html"), "utf8")
  .replace('href="style.css"', `href="${cssName}"`)
  .replace('src="main.js"', `src="${jsName}"`);
if (!html.includes(jsName) || !html.includes(cssName)) throw new Error("index.html must reference style.css and main.js");

rmSync(tmp, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
writeFileSync(join(app, "index.html"), html);
writeFileSync(join(app, jsName), js);
writeFileSync(join(app, cssName), css);
writeFileSync(join(tmp, "_headers"), readFileSync(join(src, "_headers"), "utf8"));
const old = `${out}.${process.pid}.old`;
try {
  renameSync(out, old);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
renameSync(tmp, out);
rmSync(old, { recursive: true, force: true });
console.log(`web: dist/web/app/{index.html,${jsName},${cssName}}`);
