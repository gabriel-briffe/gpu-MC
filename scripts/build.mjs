import * as esbuild from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicOpenAipConfig = path.join(root, "js/openaip-config.public.js");

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

await mkdir(root, { recursive: true });
await Promise.all([buildJs(), buildCss()]);
console.log("Built app.min.js and app.min.css");
