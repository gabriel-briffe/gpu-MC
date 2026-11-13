// js/cache/import-airports.js
// Country OpenAIP waypoint files from XCSoar (https://download.xcsoar.org/content/waypoint/country/)

const XCSOAR_OPENAIP_BASE =
  "https://download.xcsoar.org/content/waypoint/country/";

export const OPENAIP_COUNTRY_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BW","BY","BZ",
  "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ","EC","EE","EG","ER","ES","ET","FI","FJ","FK","FM","FO","FR",
  "GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GT","GU","GW","GY",
  "HK","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM","JO","JP",
  "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
  "MA","MC","MD","ME","MG","MH","MK","ML","MM","MN","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
  "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PR","PS","PT","PW","PY",
  "QA","RE","RO","RS","RU","RW","SA","SB","SC","SD","SE","SG","SH","SI","SK","SL","SN","SO","SR","SS","SV","SX","SY","SZ",
  "TC","TD","TF","TG","TH","TJ","TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ",
  "VA","VC","VE","VG","VI","VN","VU","WF","WS","XK","YE","YT","ZA","ZM","ZW"
];

function cupCoordToDecimal(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d+)(\d{2}\.\d+)([NSWE])$/i);
  if (!m) return null;
  const deg = parseInt(m[1], 10);
  const min = parseFloat(m[2]);
  let val = deg + min / 60;
  const hem = m[3].toUpperCase();
  if (hem === "S" || hem === "W") val = -val;
  return val;
}

function parseCupLine(line) {
  // Very simple CSV-ish parser that handles quoted fields with commas/newlines already stripped
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

export function parseOpenAipCup(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("name,"));
  const airports = [];
  for (const line of lines) {
    const f = parseCupLine(line);
    if (f.length < 5) continue;
    const name = f[0]?.replace(/^"|"$/g, "").trim() || "";
    const code = f[1]?.replace(/^"|"$/g, "").trim() || "";
    const country = f[2]?.trim() || "";
    const lat = cupCoordToDecimal(f[3]);
    const lon = cupCoordToDecimal(f[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    airports.push({
      lng: lon,
      lat,
      properties: {
        name: name || null,
        icao_code: code || null,
        country: country || null,
        type: null,
        source: "xcsoar-openaip-cup",
        source_id: code || `${lat.toFixed(5)},${lon.toFixed(5)}`,
      },
    });
  }
  return airports;
}

export function openAipCupUrl(countryCode) {
  return `${XCSOAR_OPENAIP_BASE}${countryCode}-WPT-National-OpenAIP.cup`;
}

export async function fetchAndParseOpenAipCountry(countryCode) {
  const url = openAipCupUrl(countryCode);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${countryCode} airports (${res.status})`);
  }
  const text = await res.text();
  return parseOpenAipCup(text);
}
