import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicOpenAipConfig = path.join(root, "js/openaip-config.public.js");

const MAPLIBRE_VENDOR_FILES = [
  "maplibre-gl.js",
  "maplibre-gl.css",
  "maplibre-gl-csp-worker.js",
];

const PRECACHE_URLS = [
  "index.html",
  "app.min.js",
  "app.min.css",
  "manifest.webmanifest",
  "sw-register.js",
  "sw.js",
  "icons/icon.svg",
  "vendor/maplibre-gl/maplibre-gl.js",
  "vendor/maplibre-gl/maplibre-gl.css",
  "vendor/maplibre-gl/maplibre-gl-csp-worker.js",
  "vendor/gribinfo/gribinfo_bg.wasm",
];

const MANIFEST = {
  name: "Mapterhorn Glide Cone",
  short_name: "Glide Cone",
  description: "GPU glide cone planner over Mapterhorn terrain",
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: "#12161c",
  theme_color: "#12161c",
  icons: [
    {
      src: "icons/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "icons/icon.svg",
      sizes: "512x512",
      type: "image/svg+xml",
      purpose: "maskable",
    },
  ],
};

const openAipConfigAliasPlugin = {
  name: "openaip-config-alias",
  setup(build) {
    build.onResolve({ filter: /openaip-config\.js$/ }, (args) => {
      if (args.path.includes("openaip-config.public.js")) {
        return null;
      }
      return { path: publicOpenAipConfig };
    });
  },
};

async function vendorGribinfo() {
  const srcWasm = path.join(root, "js/iconch1/pkg/gribinfo_bg.wasm");
  const destDir = path.join(root, "vendor/gribinfo");
  await mkdir(destDir, { recursive: true });
  await cp(srcWasm, path.join(destDir, "gribinfo_bg.wasm"));
}

async function buildJs() {
  await esbuild.build({
    entryPoints: [path.join(root, "js/main.js")],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    outfile: path.join(root, "app.min.js"),
    logLevel: "info",
    plugins: [openAipConfigAliasPlugin],
    external: [],
  });
}

async function buildCss() {
  await esbuild.build({
    entryPoints: [path.join(root, "styles.css")],
    outfile: path.join(root, "app.min.css"),
    minify: true,
    logLevel: "info",
  });
}

async function vendorMaplibre() {
  const srcDir = path.join(root, "node_modules/maplibre-gl/dist");
  const destDir = path.join(root, "vendor/maplibre-gl");
  await mkdir(destDir, { recursive: true });
  await Promise.all(
    MAPLIBRE_VENDOR_FILES.map((file) => cp(path.join(srcDir, file), path.join(destDir, file)))
  );
}

async function buildManifest() {
  await writeFile(
    path.join(root, "manifest.webmanifest"),
    `${JSON.stringify(MANIFEST, null, 2)}\n`
  );
}

async function buildServiceWorker() {
  const appJs = await readFile(path.join(root, "app.min.js"));
  const hash = createHash("sha256").update(appJs).digest("hex").slice(0, 10);
  const shellCache = `gpu-mc-shell-${hash}`;
  const swSource = await readFile(path.join(root, "scripts/sw-source.js"), "utf8");
  const preamble = `const SHELL_CACHE = ${JSON.stringify(shellCache)};\nconst PRECACHE_URLS = ${JSON.stringify(PRECACHE_URLS)};\n\n`;
  await writeFile(path.join(root, "sw.js"), preamble + swSource);
}

await mkdir(root, { recursive: true });
await buildJs();
await buildCss();
await vendorMaplibre();
await vendorGribinfo();
await buildManifest();
await buildServiceWorker();
console.log("Built app.min.js, app.min.css, vendor/maplibre-gl, manifest, and sw.js");
