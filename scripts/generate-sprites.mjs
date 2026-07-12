import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import potpack from "potpack";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "sprites", "icons");
const outputDir = path.join(root, "sprites");
const svgBase =
  "https://raw.githubusercontent.com/openAIP/openaip-map-resources/master/resources/svg";

/** Icons used by OpenAIP symbol layers (airports, obstacles, reporting points). */
const SPRITE_ICON_NAMES = [
  "apt-dot",
  "apt-tiny",
  "apt-small",
  "apt-medium",
  "apt-large",
  "ad_closed-small",
  "ad_closed-medium",
  "ad_closed-large",
  "ad_mil-small",
  "ad_mil-medium",
  "ad_mil-large",
  "af_civil-small",
  "af_civil-medium",
  "af_civil-large",
  "af_water-small",
  "af_water-medium",
  "af_water-large",
  "apt_mil_civil-small",
  "apt_mil_civil-medium",
  "apt_mil_civil-large",
  "gliding-small",
  "gliding-medium",
  "gliding-large",
  "gliding_winch-small",
  "gliding_winch-medium",
  "gliding_winch-large",
  "heli_civil-small",
  "heli_civil-medium",
  "heli_civil-large",
  "heli_mil-small",
  "heli_mil-medium",
  "heli_mil-large",
  "light_aircraft-small",
  "light_aircraft-medium",
  "light_aircraft-large",
  "ls-small",
  "ls-medium",
  "ls_agri-small",
  "ls_agri-medium",
  "ls_agri-large",
  "ls_alti-small",
  "ls_alti-medium",
  "ls_alti-large",
  "parachute-small",
  "parachute-large",
  "runway_paved-small",
  "runway_paved-medium",
  "runway_paved-large",
  "runway_unpaved-small",
  "runway_unpaved-medium",
  "runway_unpaved-large",
  "obstacle_building",
  "obstacle_chimney",
  "obstacle_obstacle",
  "obstacle_tower",
  "obstacle_wind_turbine",
  "reporting_point_compulsory-medium",
  "reporting_point_request-medium",
];

async function downloadIcons() {
  await mkdir(iconsDir, { recursive: true });
  await Promise.all(
    SPRITE_ICON_NAMES.map(async (name) => {
      const response = await fetch(`${svgBase}/${name}.svg`);
      if (!response.ok) {
        throw new Error(`Failed to download ${name}.svg (${response.status})`);
      }
      await writeFile(path.join(iconsDir, `${name}.svg`), await response.text());
    })
  );
}

async function rasterizeIcon(name, ratio) {
  const svgPath = path.join(iconsDir, `${name}.svg`);
  const buffer = await sharp(svgPath, { density: 72 * ratio }).png().toBuffer();
  const { width, height } = await sharp(buffer).metadata();
  return { name, buffer, width, height };
}

async function buildSpriteSheet(icons, ratio) {
  const padding = 2;
  const boxes = icons.map((icon) => ({
    ...icon,
    w: icon.width + padding,
    h: icon.height + padding,
  }));

  potpack(boxes);

  const sheetWidth = Math.max(...boxes.map((box) => box.x + box.w));
  const sheetHeight = Math.max(...boxes.map((box) => box.y + box.h));
  const index = {};
  const composite = [];

  for (const box of boxes) {
    index[box.name] = {
      width: box.width,
      height: box.height,
      x: box.x + 1,
      y: box.y + 1,
      pixelRatio: ratio,
    };
    composite.push({
      input: box.buffer,
      left: box.x + 1,
      top: box.y + 1,
    });
  }

  const png = await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composite)
    .png()
    .toBuffer();

  return { index, png };
}

async function generateSprites() {
  await downloadIcons();

  for (const ratio of [1, 2]) {
    const icons = await Promise.all(SPRITE_ICON_NAMES.map((name) => rasterizeIcon(name, ratio)));
    const { index, png } = await buildSpriteSheet(icons, ratio);
    const suffix = ratio === 2 ? "@2x" : "";
    await writeFile(path.join(outputDir, `sprite${suffix}.json`), JSON.stringify(index, null, 2));
    await writeFile(path.join(outputDir, `sprite${suffix}.png`), png);
  }

  console.log(`Generated ${SPRITE_ICON_NAMES.length} icons in sprites/`);
}

await generateSprites();
