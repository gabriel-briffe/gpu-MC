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

async function buildServiceWorker() {
  const appJs = await readFile(path.join(root, "app.min.js"));
  const hash = createHash("sha256").update(appJs).digest("hex").slice(0, 10);
  const shellCache = `gpu-mc-shell-${hash}`;
  const precacheUrls = [
    "/index.html",
    "/app.min.js",
    "/app.min.css",
    "/manifest.webmanifest",
    "/sw-register.js",
    "/icons/icon.svg",
    "/vendor/maplibre-gl/maplibre-gl.js",
    "/vendor/maplibre-gl/maplibre-gl.css",
    "/vendor/maplibre-gl/maplibre-gl-csp-worker.js",
  ];
  const swSource = await readFile(path.join(root, "scripts/sw-source.js"), "utf8");
  const preamble = `const SHELL_CACHE = ${JSON.stringify(shellCache)};\nconst PRECACHE_URLS = ${JSON.stringify(precacheUrls)};\n\n`;
  await writeFile(path.join(root, "sw.js"), preamble + swSource);
}

await mkdir(root, { recursive: true });
await buildJs();
await buildCss();
await vendorMaplibre();
await buildServiceWorker();
console.log("Built app.min.js, app.min.css, vendor/maplibre-gl, and sw.js");
