/*
This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
details. You should have received a copy of the GNU General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.
*/

function updateSetupSliders()
{
  let simResX = parseInt(simResSelX.value);
  let simResY = parseInt(simResSelY.value);
  let simHeight = parseInt(simHeightSel.value);

  let cellHeight = simHeight / simResY;
  let simWidth = cellHeight * simResX;

  document.getElementById('simWorldProperties').textContent = 'Hauteur de cellule : ' + cellHeight.toFixed(1) + ' m  ·  Largeur de la carte : ' + (simWidth / 1000).toFixed(1) + ' km';

  document.getElementById('simHeightWarning').style.display = (simHeight == 12000) ? 'none' : 'block';
  document.getElementById('simResYWarning').style.display = (simResY == 600) ? 'none' : 'block';
  document.getElementById('simResShowX').value = simResX;
  document.getElementById('simResShowY').value = simResY
  document.getElementById('simHeightShow').value = simHeight + ' m';
}

var FPS = 60.0;


function mixGeneric(a, b, t, {clamp = false} = {})
{
  const clampT = v => (v < 0 ? 0 : v > 1 ? 1 : v);

  if (typeof a === 'number' && typeof b === 'number') {
    const tt = clamp ? clampT(t) : t;
    return a * (1 - tt) + b * tt;
  }

  // arrays / typed arrays
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    if (!Array.isArray(b) && !ArrayBuffer.isView(b))
      throw new TypeError('mismatched types');
    if (a.length !== b.length)
      throw new RangeError('length mismatch');
    const out = new (Array.isArray(a) ? Array : a.constructor)(a.length);
    for (let i = 0; i < a.length; i++) {
      const tt = clamp ? clampT(t[i] ?? t) : (Array.isArray(t) ? t[i] ?? t : t);
      out[i] = a[i] * (1 - tt) + b[i] * tt;
    }
    return out;
  }

  // vector-like object with same keys
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = {};
    for (const k of Object.keys(a)) {
      if (typeof a[k] === 'number' && typeof b[k] === 'number') {
        const tt = clamp ? clampT(t[k] ?? t) : (t && typeof t === 'object' ? (t[k] ?? t) : t);
        out[k] = a[k] * (1 - tt) + b[k] * tt;
      }
    }
    return out;
  }

  throw new TypeError('Unsupported types for mixGeneric');
}

const corsUrl = 'https://my-cors-proxy.nielsdaemen747.workers.dev/?url='; // my own proxy worker on cloudfare

// ===================== Sounding data sources =====================
//
// Two sources, tried in this order by loadSoundingAt():
//  1) Open-Meteo (https://open-meteo.com): free, keyless, CORS-enabled weather-model profiles on 19
//     pressure levels for ANY point on earth, at ANY hour, from 2021-03-23 up to ~15 days in the future
//     (forecasts). This is what makes "any city" and in-game sounding switching reliable.
//  2) Meteociel radiosonde archive, through the CORS proxy above: real balloon observations at a fixed set
//     of launch sites (soundingStations[].id). Since mid-2026 meteociel answers automated requests with an
//     anti-bot cookie check page instead of the data table, so this is only a fallback for dates Open-Meteo
//     doesn't cover (before 2021-03-23). It is detected and reported cleanly instead of failing silently.

// Session-only cache of successfully loaded tables, keyed by "lat_lon_epoch" (never caches failures, so a
// retry after a network hiccup always refetches).
const soundingCache = new Map();

const OPEN_METEO_PRESSURE_LEVELS = [ 1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30 ];
const OPEN_METEO_LEVEL_VARS = [ 'temperature', 'dew_point', 'relative_humidity', 'wind_speed', 'wind_direction', 'geopotential_height' ];
const OPEN_METEO_SURFACE_VARS = [ 'temperature_2m', 'dew_point_2m', 'relative_humidity_2m', 'wind_speed_10m', 'wind_direction_10m', 'surface_pressure' ];
const OPEN_METEO_START_EPOCH = Date.UTC(2021, 2, 23) / 1000; // first day with pressure-level data in the historical forecast archive
const SOUNDING_MAX_FORECAST_DAYS = 15;

function isFutureTimestamp(timeStamp) { return timeStamp > Math.floor(Date.now() / 1000); }

function isBeyondForecastRange(timeStamp) { return timeStamp > Date.now() / 1000 + SOUNDING_MAX_FORECAST_DAYS * 86400; }

// Stull (2011) wet-bulb approximation, only used to fill the 'tw' column the same way meteociel's table has one.
function wetBulbStull(tC, rh)
{
  return tC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(tC + rh) - Math.atan(rh - 1.676331) +
         0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
}

// Converts one hour of an Open-Meteo pressure-level response into the exact table format scrapeTableData()
// produces for meteociel: [{alt, p, t, tw, td, rh, vel (km/h), angle}], index 0 = top, last = surface,
// pressure non-decreasing. Levels below the model terrain (p >= surface pressure) are dropped.
function openMeteoToSoundingTable(json, dateStr, hour)
{
  const hourly = json && json.hourly;
  if (!hourly || !hourly.time)
    return null;

  let i = hourly.time.indexOf(dateStr + 'T' + String(hour).padStart(2, '0') + ':00');
  if (i < 0)
    i = hour;

  const val = name => (hourly[name] && Number.isFinite(hourly[name][i])) ? hourly[name][i] : null;

  const elevation = Number.isFinite(json.elevation) ? json.elevation : 0;
  const surfaceP = val('surface_pressure');

  const rows = [];

  const sfc = {alt : elevation, p : surfaceP, t : val('temperature_2m'), td : val('dew_point_2m'), rh : val('relative_humidity_2m'), vel : val('wind_speed_10m'), angle : val('wind_direction_10m')};
  if (Object.values(sfc).every(v => v !== null))
    rows.push(sfc);

  for (const p of OPEN_METEO_PRESSURE_LEVELS) {
    const row = {alt : val('geopotential_height_' + p + 'hPa'), p : p, t : val('temperature_' + p + 'hPa'), td : val('dew_point_' + p + 'hPa'), rh : val('relative_humidity_' + p + 'hPa'), vel : val('wind_speed_' + p + 'hPa'), angle : val('wind_direction_' + p + 'hPa')};
    if (Object.values(row).some(v => v === null))
      continue;
    if (surfaceP !== null && p >= surfaceP - 2)
      continue; // underground level, extrapolated by the model
    if (row.alt <= elevation + 10)
      continue;
    rows.push(row);
  }

  for (const row of rows)
    row.tw = wetBulbStull(row.t, clamp(row.rh, 1, 100));

  rows.sort((a, b) => a.p - b.p); // top of the atmosphere first, like meteociel

  return rows.length >= 8 ? rows : null;
}

async function loadOpenMeteoSounding(lat, lon, timeStamp)
{
  const d = new Date(timeStamp * 1000);
  const dateStr = d.toISOString().slice(0, 10);
  const hour = d.getUTCHours();

  const hourlyVars = [...OPEN_METEO_SURFACE_VARS ];
  for (const p of OPEN_METEO_PRESSURE_LEVELS)
    for (const v of OPEN_METEO_LEVEL_VARS)
      hourlyVars.push(v + '_' + p + 'hPa');

  const query = 'latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) + '&start_date=' + dateStr + '&end_date=' + dateStr + '&timezone=GMT&hourly=' + hourlyVars.join(',');

  // The live forecast API covers the last ~3 months and the next 16 days, the historical forecast archive
  // everything since 2021-03-23 up to about yesterday. Try the most likely one first, the other as fallback.
  const isRecent = timeStamp > Date.now() / 1000 - 5 * 86400;
  const hosts = isRecent ? [ 'https://api.open-meteo.com/v1/forecast', 'https://historical-forecast-api.open-meteo.com/v1/forecast' ]
                         : [ 'https://historical-forecast-api.open-meteo.com/v1/forecast', 'https://api.open-meteo.com/v1/forecast' ];

  for (const host of hosts) {
    try {
      const resp = await fetch(host + '?' + query);
      if (!resp.ok)
        continue;
      const table = openMeteoToSoundingTable(await resp.json(), dateStr, hour);
      if (table && isPlausibleSoundingTable(table))
        return table;
    } catch (err) {
      console.warn('Open-Meteo indisponible (' + host + '):', err);
    }
  }
  return null;
}

// Resolves the actual PNG URL of meteociel's own official émagramme image for a station/date, by
// scraping the small graph page (map=1) the same way scrapeTableData() scrapes the raw data table
// (map=4) from the full table page. Returns null (never throws) if unavailable.
async function getSoundingGraphImgUrl(stationID, timeStamp)
{
  try {
    const imgMapType = 1; // 0 = large classic emagram, 1 = small emagram
    const graphPageUrl = 'https://www.meteociel.fr/cartes_obs/sondage_display.php?id=' + stationID + '&map=' + imgMapType + '&date=' + timeStamp;
    const response = await fetch(corsUrl + encodeURIComponent(graphPageUrl));
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const img = doc.querySelectorAll('img')[0];
    if (!img)
      return null;
    return 'https://www.meteociel.fr/' + img.getAttribute('src');
  } catch (err) {
    console.error('Image de sondage Meteociel indisponible:', err);
    return null;
  }
}

// Function to scrape table data from the given URL. Returns [] (never undefined) when the page holds no
// sounding table, e.g. meteociel's anti-bot verification page.
async function scrapeTableData(url)
{
  try {
    const response = await fetch(corsUrl + encodeURIComponent(url));
    const html = await response.text();

    if (html.includes('archive-message') || html.includes('archivebotok')) {
      console.warn('Meteociel a renvoyé sa page de vérification anti-robot au lieu du tableau du sondage.');
      return [];
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Select the rows of the main table (starting at line 51)
    const rows = doc.querySelectorAll('table:nth-of-type(2) tr:not(:first-child)');

    const tableData = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 7)
        return;

      const rowData = {
        alt : parseFloat(cells[0].textContent),
        p : parseFloat(cells[1].textContent),
        t : parseFloat(cells[2].textContent),
        tw : parseFloat(cells[3].textContent),
        td : parseFloat(cells[4].textContent),
        rh : parseFloat(cells[5].textContent),
        vel : parseFloat(cells[6].textContent.split(' / ')[1]),
        angle : parseFloat(cells[6].textContent.split(' / ')[0]),
      };

      const hasNaN = Object.values(rowData).some(v => Number.isNaN(v));

      if (!hasNaN) // discard if the row contains any NaN
        tableData.push(rowData);
    });
    return tableData;

  } catch (error) {
    console.error('Error fetching the data:', error);
    return [];
  }
}

function soundingTableUrl(stationID, timeStamp) { return 'https://www.meteociel.fr/cartes_obs/sondage_display.php?id=' + stationID + '&map=4&date=' + timeStamp; }

// A real sounding table lists pressure levels in non-decreasing order (index 0 = top of atmosphere down to
// the surface, where pressure is highest). This is 'p', not 'alt': the reported geopotential height can
// have minor local quirks near the top of the sounding on real data (harmless there since the sim never
// reaches that high), so pressure is the reliable invariant to check. Rejects results that don't look like
// an actual sounding (an unrelated table on an error page), rather than silently feeding bad data into the
// sim. High-density "TEMP HD" radiosonde tables can hold several thousand rows with tied pressure values,
// so ties are allowed and the row cap stays high.
function isPlausibleSoundingTable(table)
{
  if (!table || table.length < 2 || table.length > 5000)
    return false;

  for (let i = 1; i < table.length; i++) {
    if (table[i].p < table[i - 1].p)
      return false;
  }

  return true;
}

async function loadMeteocielSounding(stationID, timeStamp)
{
  if (isFutureTimestamp(timeStamp))
    return null;

  const url = soundingTableUrl(stationID, timeStamp);
  console.log('Fetching Meteociel sounding:', {stationId : stationID, date : new Date(timeStamp * 1000).toISOString(), url : url});

  const table = await scrapeTableData(url);
  return isPlausibleSoundingTable(table) ? table : null;
}

// Loads a sounding for a location {lat, lon, id?} at a UTC epoch (seconds): Open-Meteo first, then the
// meteociel radiosonde archive when the location is a launch site. Returns {table, source} or null; never
// throws and never fabricates data.
async function loadSoundingAt(location, timeStamp)
{
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon) || isBeyondForecastRange(timeStamp))
    return null;

  const cacheKey = location.lat.toFixed(3) + '_' + location.lon.toFixed(3) + '_' + timeStamp;
  const cached = soundingCache.get(cacheKey);
  if (cached)
    return cached;

  let result = null;

  if (timeStamp >= OPEN_METEO_START_EPOCH) {
    const table = await loadOpenMeteoSounding(location.lat, location.lon, timeStamp);
    if (table)
      result = {table, source : isFutureTimestamp(timeStamp) ? 'open-meteo-forecast' : 'open-meteo'};
  }

  if (!result && location.id) {
    const table = await loadMeteocielSounding(location.id, timeStamp);
    if (table)
      result = {table, source : 'meteociel'};
  }

  if (result)
    soundingCache.set(cacheKey, result);
  return result;
}

function soundingSourceLabel(source)
{
  switch (source) {
  case 'open-meteo-forecast':
    return 'Prévision modèle (Open-Meteo)';
  case 'open-meteo':
    return 'Analyse modèle (Open-Meteo)';
  case 'meteociel':
    return 'Radiosondage réel (Meteociel)';
  default:
    return '';
  }
}

// Linearly interpolates a station's raw sounding table to an arbitrary altitude within it, clamping
// at the top/bottom of its range. Used by the setup-screen émagramme (calcBulkShearFromTable(), the CAPE/
// CIN shading in drawSetupEmagram()). Assumes `table` is sorted the same way scrapeTableData() produces it
// (descending altitude, matching rawSoundingToSimSounding()'s own assumption).
function interpolateTableAtAltitude(table, targetAlt)
{
  if (targetAlt >= table[0].alt)
    return table[0];
  if (targetAlt <= table[table.length - 1].alt)
    return table[table.length - 1];

  for (let i = 0; i < table.length - 1; i++) {
    const upper = table[i], lower = table[i + 1];
    if (upper.alt >= targetAlt && targetAlt >= lower.alt) {
      const t = (upper.alt - targetAlt) / (upper.alt - lower.alt); // 0 at upper, 1 at lower
      return mixGeneric(upper, lower, t, {clamp : true});
    }
  }

  return table[table.length - 1];
}

// Parses a native <input type="date">'s value into a UTC epoch (seconds) at the given hour. Explicit
// regex extraction (rather than `new Date(str)`, which silently guesses a format for anything non-ISO and
// can swap month and day) returns null for anything that isn't well-formed YYYY-MM-DD.
function parseIsoDateToEpoch(isoDateStr, hour)
{
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDateStr);
  if (!m)
    return null;

  const year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
  const hourNum = parseInt(hour, 10) || 0;

  return Date.UTC(year, month - 1, day, hourNum, 0, 0) / 1000;
}

function formatSoundingTime(timeStamp)
{
  const d = new Date(timeStamp * 1000);
  return d.toLocaleDateString('fr-FR', {day : '2-digit', month : 'long', year : 'numeric', timeZone : 'UTC'}) + ' · ' + String(d.getUTCHours()).padStart(2, '0') + ' UTC';
}

// Sounding wind targets are clamped to the soft start of the velocity limiter (cells/iteration); updated from
// the "Limite de vent" setting by applyWindLimit() once the simulation runs.
var simVelTargetMax = 0.30;
var windDisplayMultiplier = 10.0; // display mode 4 color scale, set from guiControls.windDisplayKmh

// Velocity unit conversions for the current grid: raw sim velocity is in cells/iteration, and the sim's pressure
// waves ("speed of sound") travel exactly 1 cell/iteration, so the stable wind range depends on the cell size.
const WIND_LIMIT_DEFAULT_RAW = 0.6; // default horizontal wind limit, cells/iteration (soft start at 2/3 of it)
function kmhPerRawVelocity(simHeight, resY) { return (simHeight / resY) / (timePerIteration * 3600) * 3.6; }

function sampleIsInvalid(s) { return isNaN(s.t) || isNaN(s.td) || isNaN(s.vel); }

// Wind is projected onto the sim's single horizontal axis per sample (u = vel * cos(angle)) BEFORE
// interpolating between levels: interpolating the raw direction would turn e.g. 350° and 10° into 180°.
function rawSoundingToSimSounding(soundingData, simHeight, inSimSoundingRes)
{
  let soundingForSim = [];

  let soundingDataIndex = soundingData.length - 1; // start from lowest datapoint

  const uOf = s => s.vel * Math.cos(s.angle * degToRad); // km/h

  for (let y = 0; y < inSimSoundingRes; y++) {

    const inSimAlt = y * (simHeight / sim_res_y);

    while (soundingDataIndex > 0 && (soundingData[soundingDataIndex]['alt'] < inSimAlt ||
                                     sampleIsInvalid(soundingData[soundingDataIndex]))) { // go up in the sounding until the altitude matches, or is more than the in sim altitude
      soundingDataIndex--;
    }

    const sampleAboveOrEqual = soundingData[soundingDataIndex];

    const sampleBelow = soundingData[Math.min(soundingDataIndex + 1, soundingData.length - 1)];

    let s = sampleAboveOrEqual;
    let twoDimentionalVel = uOf(sampleAboveOrEqual);
    if (sampleAboveOrEqual['alt'] != sampleBelow['alt'] && inSimAlt >= soundingData[soundingData.length - 1].alt && inSimAlt <= sampleAboveOrEqual['alt']) {
      let a = (inSimAlt - sampleBelow['alt']) / (sampleAboveOrEqual['alt'] - sampleBelow['alt']);
      s = mixGeneric(sampleBelow, sampleAboveOrEqual, a);
      twoDimentionalVel = uOf(sampleBelow) * (1 - a) + uOf(sampleAboveOrEqual) * a;
    }

    // Clamped to what the sim can carry stably (VEL_SOFT in common.glsl): a jet stream faster than that would
    // only make the forcing fight the velocity limiter.
    const inSimVel = clamp(msToRawVelocity(twoDimentionalVel / 3.6), -simVelTargetMax, simVelTargetMax); // convert to m/s first

    soundingForSim[y] = {'t' : s.t, 'td' : s.td, 'vel' : inSimVel}; // Put the requered data in an array of objects
  }

  return soundingForSim;
}

var stationSelector;

// Notable convective days. Model data (Open-Meteo) exists from 2021-03-23 on; the older ones can only come
// from the meteociel radiosonde archive and are marked as such.
const presets = [
  {name : 'Tornade de Moravie du Sud (24/06/2021)', location : 'Vienna', date : '2021-06-24', hour : 15},
  {name : 'Derecho de Corse (18/08/2022)', location : 'Ajaccio', date : '2022-08-18', hour : 6},
  {name : 'Grêle géante en Frioul (24/07/2023)', location : 'Udine', date : '2023-07-24', hour : 6},
  {name : 'Orages d\'été en Italie du Nord', location : 'Milan', date : '2025-06-05', hour : 12},
  {name : 'Spring cells in Germany', location : 'Stuttgart', date : '2021-06-09', hour : 12},
  {name : 'Double inversion over Sicily', location : 'Sicily', date : '2021-07-14', hour : 12},
  {name : 'Low base with CAPE in Rome', location : 'Rome', date : '2021-07-16', hour : 12},
  {name : 'Cold winter on Gotland', location : 'Gotland', date : '2025-01-03', hour : 12},
  {name : 'High low level CAPE over the Mediterranean in fall', location : 'Ajaccio', date : '2025-10-23', hour : 12},
  {name : 'Supercell in the Netherlands (archive Meteociel)', location : 'De Bilt', date : '2014-06-09', hour : 12},
  {name : 'Some cells in the Netherlands (archive Meteociel)', location : 'Essen', date : '2016-06-23', hour : 12},
  {name : 'Hot summer in Spain (archive Meteociel)', location : 'Madrid', date : '2018-07-07', hour : 12},
];

var startDate;
var startLatitude;

// When true (setup-screen checkbox), a new simulation starts with Sounding Forcing at full strength so the
// sounding picked on the home screen actually shapes the atmosphere right away.
var applySoundingAtStart = true;

function createPresetSelect()
{
  let select = document.getElementById('presetSelect');

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choisir un scénario…';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  presets.forEach((preset, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = preset.name;
    select.appendChild(option);
  });

  select.onchange = function() {
    let preset = presets[parseInt(select.value, 10)];
    if (!preset)
      return;

    document.getElementById('datePicker').value = preset.date;
    startDate = new Date(preset.date);
    document.getElementById('hourSelector').value = preset.hour;

    setSoundingLocation(Object.assign({key : preset.location, label : preset.location}, soundingStations[preset.location]));
  };
}

// Quick-pick locations. `id` = meteociel radiosonde station id (fallback archive only), null when the
// location has no balloon launch site -- Open-Meteo works for any lat/lon. The city searched on the home
// screen is added here too (custom : true) so the in-game station switcher offers it.
const soundingStations = {
  'Andoya' : {id : 1010, lat : 69.1144, lon : 16.13},
  'Lapland' : {id : 2836, lat : 67.4160, lon : 26.60},
  'Iceland' : {id : 4018, lat : 64.9631, lon : -22.60},
  'Trondheim' : {id : 1241, lat : 63.4305, lon : 10.92},
  'Helsinki' : {id : 2963, lat : 60.1699, lon : 24.94},
  'Stavanger' : {id : 1415, lat : 58.9700, lon : 5.73},
  'Gotland' : {id : 2591, lat : 57.6359, lon : 18.35},
  'North Sea' : {id : 1400, lat : 56.5333, lon : 3.00},
  'Moscow' : {id : 27730, lat : 55.7558, lon : 37.62},
  'Gdańsk' : {id : 12120, lat : 54.3520, lon : 18.65},
  'Greifswald' : {id : 10184, lat : 54.0833, lon : 13.40},
  'Norderney' : {id : 10113, lat : 53.7000, lon : 7.15},
  'Hamburg' : {id : 10035, lat : 53.5507, lon : 9.99},
  'Nottingham' : {id : 3354, lat : 52.9500, lon : -1.15},
  'Bergen(DE)' : {id : 10238, lat : 52.8092, lon : 13.43},
  'Meppen' : {id : 10304, lat : 52.7928, lon : 7.29},
  'Berlin' : {id : 10393, lat : 52.5235, lon : 13.41},
  'Warsaw' : {id : 12374, lat : 52.2297, lon : 21.01},
  'De Bilt' : {id : 6260, lat : 52.1085, lon : 5.18},
  'Essen' : {id : 10410, lat : 51.4556, lon : 6.97},
  'Wroclaw' : {id : 12425, lat : 51.1079, lon : 17.03},
  'Brussels' : {id : 6458, lat : 50.8371, lon : 4.35},
  'Lille' : {id : null, lat : 50.6339, lon : 3.06},
  'Meiningen' : {id : 10548, lat : 50.5678, lon : 10.38},
  'Kraków' : {id : 12575, lat : 50.0647, lon : 19.94},
  'Idar-Oberstein' : {id : 10618, lat : 49.7167, lon : 7.33},
  'Nuremberg' : {id : 10771, lat : 49.4521, lon : 11.08},
  'Paris' : {id : 7145, lat : 48.8567, lon : 2.35},
  'Stuttgart' : {id : 10739, lat : 48.7758, lon : 9.18},
  'Brest' : {id : 7110, lat : 48.3900, lon : -4.49},
  'Vienna' : {id : 11035, lat : 48.2092, lon : 16.37},
  'Altenstadt' : {id : 10954, lat : 48.3556, lon : 10.87},
  'Munich' : {id : 10868, lat : 48.1333, lon : 11.58},
  'peißenberg' : {id : 10962, lat : 47.7975, lon : 11.07},
  'Insbruck' : {id : 11120, lat : 47.2692, lon : 11.40},
  'Bern' : {id : 6610, lat : 46.9480, lon : 7.45},
  'Lyon' : {id : null, lat : 45.7640, lon : 4.84},
  'Udine' : {id : 16045, lat : 46.0713, lon : 13.24},
  'Zagreb' : {id : 14240, lat : 45.8150, lon : 15.98},
  'Milan' : {id : 16064, lat : 45.4642, lon : 9.19},
  'Bordeaux' : {id : 7510, lat : 44.8378, lon : -0.58},
  'Bologna' : {id : 16144, lat : 44.4968, lon : 11.34},
  'Bucharest' : {id : 15420, lat : 44.4268, lon : 26.10},
  'Cuneo' : {id : 16113, lat : 44.3843, lon : 7.55},
  'Zadar' : {id : 14430, lat : 44.1194, lon : 15.23},
  'Montpellier' : {id : 7645, lat : 43.6119, lon : 3.88},
  'Toulouse' : {id : null, lat : 43.6047, lon : 1.44},
  'Barcelona' : {id : 8190, lat : 41.3851, lon : 2.16},
  'Ajaccio' : {id : 7761, lat : 41.9192, lon : 8.74},
  'Rome' : {id : 16245, lat : 41.9028, lon : 12.50},
  'Istanbul' : {id : 17064, lat : 41.0082, lon : 28.98},
  'Madrid' : {id : 8221, lat : 40.4168, lon : -3.70},
  'Sardinia' : {id : 16546, lat : 40.1209, lon : 9.00},
  'Lisbon' : {id : 8536, lat : 38.7223, lon : -9.14},
  'Athens' : {id : 16716, lat : 37.9792, lon : 23.73},
  'Sicily' : {id : 16429, lat : 37.6000, lon : 12.50},
  'Krete' : {id : 16754, lat : 35.2401, lon : 25.13},
  'Cyprus' : {id : 17607, lat : 35.1264, lon : 33.40},
  'Palestine' : {id : 40179, lat : 32.0853, lon : 34.81},
  'Cairo' : {id : 62378, lat : 30.0444, lon : 31.24},
  'Omaha (NE)' : {id : null, lat : 41.2565, lon : -95.94},
  'Dodge City (KS)' : {id : null, lat : 37.7528, lon : -100.02},
  'Norman (OK)' : {id : null, lat : 35.2226, lon : -97.44},
  'Dallas (TX)' : {id : null, lat : 32.7767, lon : -96.80},
  'Miami (FL)' : {id : null, lat : 25.7617, lon : -80.19},
  'Buenos Aires' : {id : null, lat : -34.6037, lon : -58.38},
  'Darwin' : {id : null, lat : -12.4634, lon : 130.84},
  'Tokyo' : {id : null, lat : 35.6762, lon : 139.65},
};

// The location the home-screen sounding is loaded for: {key, label, lat, lon, id}. `key` is its entry in
// soundingStations (custom cities are registered there by setSoundingLocation()).
var soundingLocation = null;

// Inline SVG icon from the sprite defined in index.html (<symbol id="i-NAME">), as an element.
function svgIcon(name)
{
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

// Great-circle distance in km between two lat/lon points (haversine formula).
function haversineDistanceKm(lat1, lon1, lat2, lon2)
{
  const R = 6371; // mean Earth radius, km
  const dLat = (lat2 - lat1) * degToRad;
  const dLon = (lon2 - lon1) * degToRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * degToRad) * Math.cos(lat2 * degToRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatLatLon(lat, lon) { return Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + ' ' + Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'O'); }

// Makes `loc` the active sounding location and (re)loads its sounding. A location that isn't one of the
// quick-pick stations is registered in soundingStations as the single custom entry, so the in-game switcher
// can reload it later at another date/hour.
function setSoundingLocation(loc)
{
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon))
    return;

  let key = loc.key;
  if (!key || !soundingStations[key]) {
    for (const [k, v] of Object.entries(soundingStations))
      if (v.custom)
        delete soundingStations[k];
    key = loc.label;
    soundingStations[key] = {id : null, lat : loc.lat, lon : loc.lon, custom : true};
  }

  soundingLocation = {key, label : loc.label || key, lat : loc.lat, lon : loc.lon, id : soundingStations[key].id};
  startLatitude = loc.lat; // used directly for solar-angle/day-length physics

  if (stationSelector)
    stationSelector.value = soundingStations[key].custom ? '' : key;

  const searchInput = document.getElementById('stationSearchInput');
  if (searchInput && document.activeElement !== searchInput)
    searchInput.value = soundingStations[key].custom ? loc.label : '';

  prepareSounding();
}

function createStationSelect()
{
  let select = document.getElementById('stationSelect');

  const customOption = document.createElement('option');
  customOption.value = '';
  customOption.textContent = 'Ville recherchée';
  customOption.disabled = true;
  select.appendChild(customOption);

  for (const [key, value] of Object.entries(soundingStations)) {
    let option = document.createElement('option');
    option.value = key;
    option.textContent = key + ' — ' + formatLatLon(value.lat, value.lon) + (value.id ? ' · radiosondage' : '');
    select.appendChild(option);
  }

  select.onchange = function() {
    const key = select.value;
    if (soundingStations[key])
      setSoundingLocation(Object.assign({key, label : key}, soundingStations[key]));
  };

  let datePicker = document.getElementById('datePicker');
  datePicker.onchange = function() {
    startDate = new Date(datePicker.value);
    prepareSounding();
  };

  return select;
}

// The real-world date/hour (epoch seconds) last configured on the setup screen. Used ONLY to seed
// guiControls.soundingDate/soundingHour once when the in-game controls are built (see setupDatGui()).
var lastSoundingEpochTime = null;

// Worldwide place search: Open-Meteo geocoding (GeoNames, fast, city-oriented, CORS-enabled), falling back to
// OpenStreetMap Nominatim for small places it doesn't know. Resolves to [{name, region, country, lat, lon}].
async function geocodePlaces(query, signal)
{
  const results = [];
  try {
    const resp = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=8&language=fr&format=json&name=' + encodeURIComponent(query), {signal});
    if (resp.ok) {
      const json = await resp.json();
      for (const r of (json.results || []))
        results.push({name : r.name, region : r.admin1 || '', country : r.country || r.country_code || '', lat : r.latitude, lon : r.longitude});
    }
  } catch (err) {
    if (err.name === 'AbortError')
      throw err;
    console.warn('Géocodage Open-Meteo indisponible:', err);
  }

  if (results.length > 0)
    return results;

  const resp = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&accept-language=fr&q=' + encodeURIComponent(query), {signal});
  if (!resp.ok)
    throw new Error('HTTP ' + resp.status);
  for (const r of await resp.json()) {
    const a = r.address || {};
    results.push({name : a.city || a.town || a.village || a.municipality || a.county || r.display_name.split(',')[0], region : a.state || '', country : a.country || '', lat : parseFloat(r.lat), lon : parseFloat(r.lon)});
  }
  return results;
}

// Home-screen search box: instant matches among the quick-pick stations, plus a debounced worldwide
// geocoding lookup so ANY city or village can be picked. Arrow keys + Enter navigate the suggestions.
function setupStationSearch()
{
  const searchInput = document.getElementById('stationSearchInput');
  const suggestionsEl = document.getElementById('citySearchResults');

  if (!searchInput || !suggestionsEl)
    return;

  let items = [];       // [{label, sub, loc}] currently rendered
  let activeIndex = -1; // keyboard-highlighted suggestion

  function hideSuggestions()
  {
    suggestionsEl.innerHTML = '';
    suggestionsEl.hidden = true;
    items = [];
    activeIndex = -1;
  }

  function choose(item)
  {
    hideSuggestions();
    searchInput.value = item.label;
    searchInput.blur();
    setSoundingLocation(item.loc);
  }

  function render(message)
  {
    suggestionsEl.innerHTML = '';
    items.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'city-suggestion' + (index === activeIndex ? ' active' : '');
      el.appendChild(svgIcon(item.icon || 'pin'));
      const nameEl = document.createElement('span');
      nameEl.className = 'city-suggestion-name';
      nameEl.textContent = item.label; // textContent: names come from an external API, never trusted as markup
      const subEl = document.createElement('span');
      subEl.className = 'city-suggestion-country';
      subEl.textContent = item.sub;
      el.appendChild(nameEl);
      el.appendChild(subEl);
      el.addEventListener('mousedown', event => {
        event.preventDefault(); // keep focus so 'blur' doesn't hide the list before the click registers
        choose(item);
      });
      suggestionsEl.appendChild(el);
    });
    if (message) {
      const el = document.createElement('div');
      el.className = 'city-suggestion city-suggestion-empty';
      el.textContent = message;
      suggestionsEl.appendChild(el);
    }
    suggestionsEl.hidden = suggestionsEl.children.length === 0;
  }

  function localMatches(queryLower)
  {
    return Object.entries(soundingStations)
        .filter(([key, v]) => !v.custom && key.toLowerCase().includes(queryLower))
        .slice(0, 4)
        .map(([key, v]) => ({label : key, icon : v.id ? 'balloon' : 'star', sub : (v.id ? 'station de radiosondage · ' : 'favori · ') + formatLatLon(v.lat, v.lon), loc : Object.assign({key, label : key}, v)}));
  }

  let abortController = null;
  let debounceTimer = null;

  async function searchWorldwide(query, local)
  {
    if (abortController)
      abortController.abort();
    abortController = new AbortController();

    try {
      const places = await geocodePlaces(query, abortController.signal);
      const seen = new Set();
      const remote = [];
      for (const p of places) {
        const id = p.name + '|' + p.region + '|' + p.country;
        if (seen.has(id) || !Number.isFinite(p.lat) || !Number.isFinite(p.lon))
          continue;
        if (local.some(i => haversineDistanceKm(i.loc.lat, i.loc.lon, p.lat, p.lon) < 15))
          continue; // same place as a favorite already listed
        seen.add(id);
        remote.push({label : p.name, icon : 'pin', sub : [ p.region, p.country ].filter(Boolean).join(', '), loc : {label : p.country ? p.name + ', ' + p.country : p.name, lat : p.lat, lon : p.lon}});
      }
      items = local.concat(remote);
      activeIndex = items.length > 0 ? 0 : -1;
      render(items.length === 0 ? 'Aucun lieu trouvé pour « ' + query + ' »' : null);
    } catch (err) {
      if (err.name === 'AbortError')
        return; // superseded by a newer keystroke
      console.error('Erreur recherche de ville:', err);
      render('Recherche indisponible (hors ligne ?)');
    }
  }

  searchInput.addEventListener('input', function() {
    const query = searchInput.value.trim();
    clearTimeout(debounceTimer);

    if (query.length === 0) {
      hideSuggestions();
      return;
    }

    const local = localMatches(query.toLowerCase());
    items = local;
    activeIndex = local.length > 0 ? 0 : -1;
    render(query.length >= 2 ? 'Recherche dans le monde entier…' : null);

    if (query.length >= 2)
      debounceTimer = setTimeout(() => searchWorldwide(query, local), 300);
  });

  searchInput.addEventListener('keydown', function(event) {
    if (suggestionsEl.hidden || items.length === 0)
      return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeIndex >= 0)
        choose(items[activeIndex]);
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  });

  searchInput.addEventListener('blur', function() { setTimeout(hideSuggestions, 150); }); // slight delay so a suggestion's mousedown still fires first
}

function setupSoundingDateControls()
{
  const datePicker = document.getElementById('datePicker');
  const hourSelector = document.getElementById('hourSelector');

  const todayIso = d => d.toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + SOUNDING_MAX_FORECAST_DAYS * 86400 * 1000);
  datePicker.max = todayIso(maxDate);

  // Start on today's sounding (or a forecast for later today) rather than an arbitrary fixed date.
  datePicker.value = todayIso(new Date());

  for (const btn of document.querySelectorAll('[data-day-offset]')) {
    btn.addEventListener('click', function() {
      datePicker.value = todayIso(new Date(Date.now() + parseInt(btn.dataset.dayOffset, 10) * 86400 * 1000));
      startDate = new Date(datePicker.value);
      prepareSounding();
    });
  }

  hourSelector.addEventListener('change', prepareSounding);

  const applyCheckbox = document.getElementById('applySoundingAtStart');
  if (applyCheckbox) {
    applyCheckbox.checked = applySoundingAtStart;
    applyCheckbox.addEventListener('change', () => { applySoundingAtStart = applyCheckbox.checked; });
  }
}

// Ensure the DOM is fully loaded before running the function
document.addEventListener('DOMContentLoaded', () => {
  createPresetSelect();
  stationSelector = createStationSelect();
  setupStationSearch();
  setupSoundingDateControls();
  setSoundingLocation({key : 'Munich', label : 'Munich', lat : soundingStations['Munich'].lat, lon : soundingStations['Munich'].lon});

  const pendingGridResY = localStorage.getItem('pendingGridResY');
  if (pendingGridResY) {
    localStorage.removeItem('pendingGridResY');
    document.getElementById('simResSelY').value = pendingGridResY;
    updateSetupSliders();
  }
});

var canvas;
var gl;

var clockEl;

var atmosStatsEl;
var lastAtmosStats = null; // last computed {CAPE, CIN, LCL_height, shear06, STP}, shown in soundingGraph and the main UI

var sirenToggleEl; // always-visible general-UI button that mirrors/drives guiControls.sirenMuted

// Keeps the on-screen siren button and the dat.GUI checkbox in sync no matter which one the user
// clicked (or if a weather station panel's own siren icon changed it).
function updateSirenToggleButton()
{
  if (!sirenToggleEl)
    return;

  if (guiControls.sirenMuted) {
    sirenToggleEl.innerHTML = '🔇 Sirène coupée';
    sirenToggleEl.style.background = '#552222';
  } else {
    sirenToggleEl.innerHTML = '🔊 Sirène active';
    sirenToggleEl.style.background = '#225522';
  }
}

var tornadoWarningCanvas;
var tornadoWarningCtx;
var tornadoWarning = {active : false, simX : 0, simY : 0, windX : 0}; // updated every frame by updateAtmosStatsForHail()

var simDateTime;

var SETUP_MODE = false;

var loadingBar;
var cam;
var soundSystem;

const PI = 3.14159265359;
const degToRad = 0.0174533;
const radToDeg = 57.2957795;
const kmToMil = 0.62137;
const mToFt = 3.28084;

const saveFileVersionID = 263574036; // Uint32 id to check if save file is compatible

const guiControls_default = {
  vorticity : 0.005,
  dragMultiplier : 0.001, // 0.01
  wind : 0.0,
  globalEffectsStartAlt : 0,
  globalEffectsEndAlt : 10000,
  globalDrying : 0.000000, // 0.000010
  globalHeating : 0.0,
  soundingForcing : 0.0,
  sunIntensity : 1.0,
  waterTemperature : 25.0, // °C
  dynamicWaterTemperature : true,
  landEvaporation : 0.00005,
  waterEvaporation : 0.0001,
  evapHeat : 2.90,          //  Real: 2260 J/g
  meltingHeat : 0.43,       //  Real:  334 J/g
  condensationRate : 0.0050,
  waterWeight : 0.25,       // 0.50
  inactiveDroplets : 0,
  aboveZeroThreshold : 1.0, // PRECIPITATION
  subZeroThreshold : 0.005, // 0.01
  spawnChance : 0.00005,    // 30. 10 to 50
  snowDensity : 0.2,        // 0.3
  fallSpeed : 0.0003,
  growthRate0C : 0.0001,    // 0.0005
  growthRate_30C : 0.001,   // 0.01
  freezingRate : 0.01,
  meltingRate : 0.01,
  evapRate : 0.0008, // 0.0005
  displayMode : 'DISP_REAL',
  wrapHorizontally : true,
  SmoothCam : true,
  camSpeed : 0.01,
  exposure : 1.0,
  timeOfDay : 9.9,
  latitude : 45.0,
  month : 6.65, // Northern hemisphere summer solstice
  sunAngle : 9.9,
  dayNightCycle : true,
  accelerateNight : true,
  greenhouseGases : 0.0010,
  waterGreenHouseEffect : 0.0023,
  IR_rate : 1.0,
  tool : 'TOOL_NONE',
  brushSize : 20,
  wholeWidth : false,
  brushIntensity : 0.01,
  allowCaves : true,
  showGraph : false,
  realDewPoint : false, // show real dew point in graph, instead of dew point with cloud water included
  enablePrecipitation : true,
  lightningEnabled : true,
  hailEnabled : true,
  hailCapeThreshold : 1500, // J/kg. CAPE above which storms start producing hail
  hailMeltingRate : 0.002,  // how fast hail melts back to rain as it falls through air above 0C (kept low so it can actually reach the ground)
  sirenMuted : false,       // silences the tornado siren regardless of STP, without disabling the warning icon/track
  showTornadoWarning : true, // show the NWS-style warning icon and projected path when STP is extreme and a funnel reaches the ground
  showDrops : false,
  paused : false,
  IterPerFrame : 10,
  auto_IterPerFrame : true,
  sound : true,
  dryLapseRate : 10.0,     // Real: 9.8 degrees / km
  simHeight : 12000,       // meters
  gridResY : 600,          // vertical grid resolution (cells). Changing it restarts the simulation.
  CAPE : 0,                // read-only gauge, updated live from the sounding column under the mouse
  STP : 0,                 // read-only gauge, updated live from the sounding column under the mouse
  twelveHourClock : false, // only for display.  false = metric
  lengthUnit : 'LENGTH_UNIT_METRIC',
  tempUnit : 'TEMP_UNIT_C',
  speedUnit : 'SPEED_UNIT_KMH',
  showStationMarkers : true, // real Meteociel radiosonde station pins overlaid on the main view, click to load that station's real sounding for the live Sounding Forcing
  activeSoundingStation : 'Munich', // matches createStationSelect()'s own default (id 10868) on the setup screen
  soundingDate : '2025-06-15',      // in-game Sounding Date (YYYY-MM-DD); re-seeded from the setup screen's own date once mainScript() starts -- see setupDatGui()
  soundingHour : 12,                // in-game Sounding Hour (UTC, 0-23)
  windCeilingAlt : 8000,
  windLimitKmh : 0,
  shearSmoothing : 1.0,
  classicWind : false,              // true = original wind physics (no speed limiter, no Richardson mixing) for comparison
  windDisplayKmh : 0,               // horizontal wind speed shown at full color in display mode 4; 0 = automatic (original scale)             // 0..1: smooths overly sharp vertical wind shear (jet edges) to prevent Kelvin-Helmholtz waves                 // flow speed limit (km/h) for numerical stability; 0 = automatic safe value for the grid
  skyEffects : true,                // sun disc, moon, stars and sunrise/sunset sky colors in the background            // meters. Above this altitude the wind (global wind force + sounding wind) fades smoothly to 0 at the top of the map
};

var horizontalDisplayMult = 3.0; // 3.0 to cover srceen while zoomed out

// Starts out as the defaults (rather than undefined) so unit-formatting helpers (printTemp() etc.) work
// on the setup screen too -- setupDatGui() fully replaces this once mainScript() actually runs.
var guiControls = guiControls_default;

var displayVectorField = false;

var displayWeatherStations = true;

var sunIsUp = true;

var airplaneMode = false;

var dropletFollowID = -1;

var minShadowLight = 0.02;

var saveFileName = '';

var guiControlsFromSaveFile = null;
var datGui;

var sim_res_x;
var sim_res_y;
var sim_aspect; //  = sim_res_x / sim_res_y
var sim_height = 12000;

var cellHeight = 12000. / 600.; // guiControls.simHeight / sim_res_y;  // in meters // cell width is the same

var frameNum = 0;
var lastFrameNum = 0;

var iterNum = 0;

// global framebuffers for measurements
var frameBuff_0;
var frameBuff_1; // read by Weatherstation.measure() (top-level class), so must be a real global, not a
                  // mainScript()-local const -- it holds the previous-frame textures used for station STP
var lightFrameBuff_0;

var dryLapse;


const timePerIteration = 0.00008; // in hours (0.00008 = 0.288 sec, at 40m cell size that means the speed of light & sound = 138.88 m/s = 500 km/h)

var NUM_DROPLETS;
const NUM_DROPLETS_DEVIDER = 25; // 25

let hdrFBO;

let bloomFBOs = [];

let ambientLightFBOs = [];
let emittedLightFBO;


function clamp(num, min, max) { return Math.min(Math.max(num, min), max); }

function screenToSimX(screenX)
{
  let leftEdge = canvas.width / 2.0 - (canvas.width * cam.curZoom) / 2.0;
  let rightEdge = canvas.width / 2.0 + (canvas.width * cam.curZoom) / 2.0;
  return map_range(screenX, leftEdge, rightEdge, 0.0, 1.0) - cam.curXpos / 2.0;
}

function screenToSimY(screenY)
{
  let topEdge = canvas.height / 2.0 - ((canvas.width / sim_aspect) * cam.curZoom) / 2.0;
  let bottemEdge = canvas.height / 2.0 + ((canvas.width / sim_aspect) * cam.curZoom) / 2.0;
  return map_range(screenY, bottemEdge, topEdge, 0.0, 1.0) - (cam.curYpos / 2.0) * sim_aspect;
}

function simToScreenX(simX)
{
  simX += 0.5;
  simX /= sim_res_x;
  let leftEdge = canvas.width / 2.0 - (canvas.width * cam.curZoom) / 2.0;
  let rightEdge = canvas.width / 2.0 + (canvas.width * cam.curZoom) / 2.0;
  return map_range(simX + cam.curXpos / 2.0, 0.0, 1.0, leftEdge, rightEdge);
}

function simToScreenY(simY)
{
  simY += 0.5; // center in cell
  simY /= sim_res_y;
  let topEdge = canvas.height / 2.0 - ((canvas.width / sim_aspect) * cam.curZoom) / 2.0;
  let bottemEdge = canvas.height / 2.0 + ((canvas.width / sim_aspect) * cam.curZoom) / 2.0;
  return map_range(simY + (cam.curYpos / 2.0) * sim_aspect, 0.0, 1.0, bottemEdge, topEdge);
}

function download(filename, data)
{
  var url = URL.createObjectURL(data);
  const element = document.createElement('a');
  element.setAttribute('href', url);
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

// Universal Functions

function mod(a, b)
{
  // proper modulo to handle negative numbers
  return ((a % b) + b) % b;
}

function map_range(value, low1, high1, low2, high2) { return low2 + ((high2 - low2) * (value - low1)) / (high1 - low1); }

function map_range_C(value, low1, high1, low2, high2) { return clamp(low2 + ((high2 - low2) * (value - low1)) / (high1 - low1), Math.min(low2, high2), Math.max(low2, high2)); }

// Temperature Functions

function CtoK(C) { return C + 273.15; }

function KtoC(K) { return K - 273.15; }

function CtoF(C) { return C * 1.8 + 32.0; }


function dT_saturated(dTdry, dTl)
{
  // dTl = temperature difference because of latent heat
  // if (dTl == 0.0)
  //   return dTdry;
  //  else {
  var multiplier = dTdry / (dTdry - dTl);
  return dTdry * multiplier;
  // }
}

const IR_constant = 5.670374419; // ×10−8

function IR_emitted(T)
{
  return Math.pow(T * 0.01, 4) * IR_constant; // Stefan–Boltzmann law
}

function IR_temp(IR)
{
  // inversed Stefan–Boltzmann law
  return Math.pow(IR / IR_constant, 1.0 / 4.0) * 100.0;
}

////////////// Water Functions ///////////////
const wf_devider = 250.0;
const wf_pow = 17.0;

function maxWater(Td)
{
  return Math.pow(Td / wf_devider,
                  wf_pow); // w = ((Td)/(250))^(18) // Td in Kelvin, w in grams per m^3
}

function dewpoint(W)
{
  //  if (W < 0.00001) // can't remember why this was here...
  //    return 0.0;
  //  else
  return wf_devider * Math.pow(W, 1.0 / wf_pow);
}

function relativeHumd(T, W) { return (W / maxWater(T)) * 100.0; }

////////////// Atmospheric Indices (CAPE / CIN / STP) ///////////////

const gravity = 9.80665; // m/s^2

// Lifts a surface parcel using the same dry/moist adiabat model as the sounding graph's
// rising-parcel line, integrating buoyancy against the environment to get CAPE, CIN and the LCL height.
function calcParcelIndices(baseTextureValues, waterTextureValues, wallTextureValues, surfaceLevel)
{
  const dz = guiControls.simHeight / sim_res_y;
  const drylapsePerCell = -(dz * guiControls.dryLapseRate) / 1000.0;

  const water = waterTextureValues[4 * surfaceLevel]; // total water carried by the parcel (conserved during ascent)
  const potentialTemp0 = baseTextureValues[4 * surfaceLevel + 3];

  let prevTemp = potentialTemp0 - (surfaceLevel / sim_res_y) * guiControls.simHeight * guiControls.dryLapseRate / 1000.0;
  let prevCloudWater = waterTextureValues[4 * surfaceLevel + 1];

  let CAPE = 0.0;
  let CIN = 0.0;
  let LCL_height = guiControls.simHeight;
  let foundLCL = false;
  let sawPositiveBuoyancy = false;

  for (let y = surfaceLevel + 1; y < sim_res_y; y++) {
    if (wallTextureValues[4 * y + 1] == 0)
      break; // left the fluid domain

    const cloudWater = Math.max(water - maxWater(prevTemp + drylapsePerCell), 0.0);
    const dWt = (cloudWater - prevCloudWater) * guiControls.evapHeat;
    const Tparcel = prevTemp + dT_saturated(drylapsePerCell, dWt);

    if (!foundLCL && cloudWater > 0.0) {
      foundLCL = true;
      LCL_height = map_range(y, 0, sim_res_y, 0, guiControls.simHeight);
    }

    const potentialTempEnv = baseTextureValues[4 * y + 3];
    const Tenv = potentialTempEnv - (y / sim_res_y) * guiControls.simHeight * guiControls.dryLapseRate / 1000.0;

    const work = gravity * ((Tparcel - Tenv) / Tenv) * dz; // buoyant work per unit mass over this layer

    if (Tparcel > Tenv) {
      CAPE += work;
      sawPositiveBuoyancy = true;
    } else if (!sawPositiveBuoyancy) {
      CIN += work; // negative: layers below the level of free convection
    }

    prevTemp = Tparcel;
    prevCloudWater = Math.max(water - maxWater(prevTemp), 0.0);
  }

  return {CAPE, CIN, LCL_height};
}

// Bulk (speed-only) wind shear between the surface and 1km / 6km AGL. This sandbox is a 2D
// vertical slice with a single horizontal wind component, so directional/hodograph shear isn't available.
function calcBulkShear(baseTextureValues, surfaceLevel)
{
  const dz = guiControls.simHeight / sim_res_y;
  const y1km = Math.min(surfaceLevel + Math.round(1000.0 / dz), sim_res_y - 1);
  const y6km = Math.min(surfaceLevel + Math.round(6000.0 / dz), sim_res_y - 1);

  const uSurface = rawVelocityTo_ms(baseTextureValues[4 * surfaceLevel]);
  const u1km = rawVelocityTo_ms(baseTextureValues[4 * y1km]);
  const u6km = rawVelocityTo_ms(baseTextureValues[4 * y6km]);

  return {shear01 : Math.abs(u1km - uSurface), shear06 : Math.abs(u6km - uSurface)};
}

// Simplified Significant Tornado Parameter (fixed-layer SPC formula). True storm-relative helicity (SRH)
// needs a turning wind hodograph -- a second horizontal wind component this 2D sandbox doesn't simulate --
// so it can't be computed directly. As a physically-motivated stand-in, low-level (0-1km) bulk shear is
// used for the helicity/EHI term: it's the closest available proxy for near-surface rotational potential.
function calcSTP(CAPE, CIN, LCL_height, shear06, shear01)
{
  const capeTerm = CAPE / 1500.0;
  const lclTerm = clamp((2000.0 - LCL_height) / 1000.0, 0.0, 1.0);
  const shearTerm = clamp(shear06 / 20.0, 0.0, 1.5);
  const cinTerm = clamp((200.0 + CIN) / 150.0, 0.0, 1.0);
  const helicityTerm = clamp(shear01 / 10.0, 0.0, 1.5); // EHI/helicity proxy: 0-1km shear

  return Math.max(capeTerm * lclTerm * shearTerm * cinTerm * helicityTerm, 0.0);
}

// Print funtions:

function convertTempToSelectedUnit(tempC)
{
  switch (guiControls.tempUnit) {
  case 'TEMP_UNIT_C':
    return tempC;
  case 'TEMP_UNIT_F':
    return CtoF(tempC);
  case 'TEMP_UNIT_K':
    return (tempC + 273.15);
  }
}

function printTemp(tempC)
{
  let tempStr = convertTempToSelectedUnit(tempC).toFixed(1);
  switch (guiControls.tempUnit) {
  case 'TEMP_UNIT_C':
    return tempStr + '°C';
  case 'TEMP_UNIT_F':
    return tempStr + '°F';
  case 'TEMP_UNIT_K':
    return tempStr + ' K';
  }
}

function mmToIn(mm) { return mm * 0.393701; }

function msToKnots(ms) { return ms * 1.94384; };

function msToMPH(ms) { return ms * 2.23694; };

function knotsToMs(kt) { return kt * 0.514444; };

function printSnowHeight(snowHeight_cm)
{
  if (guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL') {
    return mmToIn(snowHeight_cm).toFixed(1) + '"'; // inches
  } else
    return snowHeight_cm.toFixed(1) + ' cm';
}

function printSoilMoisture(soilMoisture_mm)
{
  if (guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL') {
    return mmToIn(soilMoisture_mm).toFixed(1) + '"'; // inches
  } else
    return soilMoisture_mm.toFixed(1) + ' mm';
}

function printHailSize(hailSize_cm)
{
  if (guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL') {
    return mmToIn(hailSize_cm).toFixed(2) + '"'; // inches
  } else
    return hailSize_cm.toFixed(2) + ' cm';
}


function printDistance(m)
{
  if (guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL') {
    let miles = m * kmToMil / 1000;
    let ft = m * mToFt;
    return miles < 1.0 ? ft.toFixed(0) + ' ft' : miles.toFixed(1) + ' miles';
  } else {
    let km = m / 1000;
    return m < 1000 ? m.toFixed(0) + ' m' : km.toFixed(1) + ' km';
  }
}

function printAltitude(meters)
{
  if (guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL') {
    let feet = meters * mToFt;
    return feet.toFixed() + ' ft';
  } else
    return meters.toFixed() + ' m';
}

function convertVelocityToSelectedUnit(ms)
{
  switch (guiControls.speedUnit) {
  case 'SPEED_UNIT_KMH':
    return ms * 3.6;
  case 'SPEED_UNIT_MS':
    return ms;
  case 'SPEED_UNIT_MPH':
    return msToMPH(ms);
  case 'SPEED_UNIT_KT':
    return msToKnots(ms);
  }
}

function printVelocity(ms)
{
  let velStr = convertVelocityToSelectedUnit(ms).toFixed();
  switch (guiControls.speedUnit) {
  case 'SPEED_UNIT_KMH':
    return velStr + ' km/h';
  case 'SPEED_UNIT_MS':
    return velStr + ' m/s';
  case 'SPEED_UNIT_MPH':
    return velStr + ' MPH';
  case 'SPEED_UNIT_KT':
    return velStr + ' kt';
  }
}

function printVerticalVelocity(ms)
{
  let veloStr = ms >= 0. ? '+' : '';
  let unitStr = '';

  if (guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL') {
    veloStr += (ms * 196.8504).toFixed(0);
    unitStr = ' ft/m';
  } else {
    veloStr += ms.toFixed(1);
    unitStr = ' m/s';
  }
  return [ veloStr, unitStr ];
}

function rawVelocityTo_ms(vel)
{                          // Raw velocity is in cells/iteration
  vel /= timePerIteration; // convert to cells per hour
  vel *= cellHeight;       // convert to meters per hour
  vel /= 3600.0;           // convert to m/s
  return vel;
}

function msToRawVelocity(vel)
{                          // Raw velocity is in cells/iteration
  vel *= 3600;             // convert to meters per hour
  vel /= cellHeight;       // convert to cells per hour
  vel *= timePerIteration; // convert to raw (cells per iteration)
  return vel;
}

function CtoK(c) { return c + 273.15; }

function realToPotentialT(realT, y) { return realT + (y / sim_res_y) * dryLapse; }

function potentialToRealT(potentialT, y) { return potentialT - (y / sim_res_y) * dryLapse; }


// Global Classes:

class Vec2D // simple 2D vector
{
  x;
  y;
  constructor(x = 0, y = 0)
  {
    this.x = x;
    this.y = y;
  }
  static fromAngle(angle, mag) // create vector from angle and optional magnitude
  {
    if (mag == null)
      mag = 1.0;
    let x = -Math.cos(angle) * mag;
    let y = Math.sin(angle) * mag;
    return new Vec2D(x, y);
  }

  copy() { return new Vec2D(this.x, this.y); }
  add(other)
  {
    this.x += other.x;
    this.y += other.y;
    return this;
  }
  subtract(other)
  {
    this.x -= other.x;
    this.y -= other.y;
    return this;
  }
  mult(mult)
  {
    this.x *= mult;
    this.y *= mult;
    return this;
  }
  div(div)
  {
    this.x /= div;
    this.y /= div;
    return this;
  }

  rotate(angle) // rotate vector
  {
    let newX = Math.sin(angle) * this.y + Math.cos(angle) * this.x;
    this.y = Math.cos(angle) * this.y - Math.sin(angle) * this.x;
    this.x = newX;
    return this;
  }

  mag() { return Math.sqrt(this.x * this.x + this.y * this.y); } // get magnitude of vector

  magSq() { return this.x * this.x + this.y * this.y; }          // square of magnitude

  angle()                                                        // get angle of vector
  {
    return Math.atan(this.y / -this.x);
  }
}

class FBO // wraps texture, frambuffer and info in one
{
  width;
  height;
  texelSizeX;
  texelSizeY;
  texture;
  frameBuffer;

  constructor(w, h, internalFormat, format, type, texFilter, wrapMode_S)
  {
    this.width = w;
    this.height = h;
    gl.activeTexture(gl.TEXTURE0);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, texFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, texFilter);

    if (!wrapMode_S)
      wrapMode_S = gl.CLAMP_TO_EDGE;

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode_S);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    this.frameBuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frameBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.texelSizeX = 1.0 / this.width;
    this.texelSizeY = 1.0 / this.height;
  }
}

function createHdrFBO() { hdrFBO = new FBO(canvas.width, canvas.height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR); }

function createBloomFBOs()
{
  let res = new Vec2D(canvas.width, canvas.height);

  bloomFBOs.length = 0;           // empty array
  for (let i = 0; i < 100; i++) { // max bloom iterations
    let width = res.x >> i;       // right shift to devide by 2 multiple times
    let height = res.y >> i;

    //  console.log('BloomFBO', i, width, height)

    if (width < 2 || height < 2)
      break; // stop when texture resolution is 2 x 2

    let fbo = new FBO(width, height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    bloomFBOs.push(fbo);
  }
}


function createAmbientLightFBOs()
{
  emittedLightFBO = new FBO(sim_res_x, sim_res_y, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);

  let res = new Vec2D(sim_res_x, sim_res_y);

  // console.log('createAmbientLightFBOs');

  ambientLightFBOs.length = 0;   // empty array
  for (let i = 0; i < 80; i++) { // max iterations
    let width = res.x >> i;      // right shift to devide by 2 multiple times
    let height = res.y >> i;

    if (width < 2 || height < 2)
      break; // stop when texture width or height is <= 2

    let fbo = new FBO(width, height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR, gl.REPEAT);
    ambientLightFBOs.push(fbo);
  }
}

class Weatherstation
{
  static #sirenIconX = 100; // top-right corner hit-box for the per-station siren mute/unmute icon
  static #sirenIconY = 16;

  #width = 120; // 100 display size
  #height = 70; // 55
  #mainDiv;
  #canvas;
  #c; // 2d canvas context
  #x; // position in simulation
  #y;

  #alarmEnabled = true; // per-station tornado siren toggle, independent of every other station and of guiControls.sirenMuted

  #isOnLand = false;
  #isOnWater = false;

  #time;             // ISO time string of moment of last measurement
  #temperature = 0;  // °C
  #dewpoint = 0;     // °C
  #relativeHumd = 0; // %
  #velocity = 0;     // ms
  #soilMoisture = 0; // mm
  #snowHeight = 0;   // cm
  #hailSize = 0;     // cm, estimated diameter
  #stp = 0;          // Significant Tornado Parameter, computed from this station's own vertical column
  #airQuality = 0;   // AQI
  #waterTemperature = 0;

  #netIRpow = 0;
  #solarPower = 0;

  #chartCanvas;
  #historyChart;

  #displaySunAndIRPower;


  constructor(xIn, yIn)
  {
    this.#x = Math.floor(xIn);
    this.#y = Math.floor(yIn);
    this.#mainDiv = document.createElement('div');
    this.#canvas = document.createElement('canvas');
    this.#mainDiv.appendChild(this.#canvas);
    document.body.appendChild(this.#mainDiv);
    this.#canvas.height = this.#height;
    this.#canvas.width = this.#width;

    this.#mainDiv.style.position = 'absolute';
    this.#mainDiv.style.width = '0px';
    this.#mainDiv.style.height = '0px';

    this.#c = this.#canvas.getContext('2d');

    this.#canvas.style.position = 'absolute';
    this.#canvas.style.zIndex = 1; // z-index

    this.#displaySunAndIRPower = false;

    let thisObj = this;
    this.#canvas.addEventListener('mousedown', function(event) {
      if (event.button == 0) {     // left mouse button
        const clickX = event.offsetX, clickY = event.offsetY;
        if (clickX >= Weatherstation.#sirenIconX && clickY <= Weatherstation.#sirenIconY) { // this station's own siren toggle icon, top-right corner
          thisObj.#alarmEnabled = !thisObj.#alarmEnabled;
          event.stopPropagation();
        } else if (guiControls.tool == 'TOOL_STATION') {
          thisObj.destroy();       // remove weather station
          event.stopPropagation(); // prevent mousedown on body from firing
        } else {
          if (guiControls.dayNightCycle == true) {
            thisObj.#chartCanvas.style.display = (thisObj.#chartCanvas.style.display == 'none') ? 'block' : 'none'; // toggle visibility of chart canvas
          }
        }
      } else if (event.button == 2) {                                   // right mouse button
        thisObj.#displaySunAndIRPower = !thisObj.#displaySunAndIRPower; // toggle display of radiation flux
      }
    });

    this.#canvas.addEventListener('contextmenu', function(event) { event.preventDefault(); }); // Prevent the browser's context menu from appearing

    this.createChartJSCanvas();
  }

  createChartJSCanvas()
  {
    this.#chartCanvas = document.createElement('canvas');

    this.#mainDiv.appendChild(this.#chartCanvas);

    const ctx = this.#chartCanvas.getContext('2d');

    this.#chartCanvas.height = 400;
    this.#chartCanvas.width = 500;

    let style = this.#chartCanvas.style;

    style.marginTop = '100px';

    style.position = 'relative';

    style.left = '-200px';

    style.display = 'none'; // hide initially


    this.#historyChart = new Chart(ctx, {
      type : 'line',
      data : {
        labels : [], // Time-based labels
        datasets : [
          {
            label : 'Temperature',
            data : [],
            backgroundColor : 'rgba(255, 0, 0, 0.9)',
            borderColor : 'rgba(255, 0, 0, 1)',
            radius : 0,
            borderWidth : 1,
            fill : false,
          },
          {
            label : 'Dew Point',
            data : [],
            backgroundColor : '#00FFFF',
            borderColor : '#00FFFF',
            radius : 0,
            borderWidth : 1,
            fill : false,
          },
          {label : 'Wind Speed', data : [], backgroundColor : '#AAAAAA', borderColor : '#AAAAAA', radius : 0, borderWidth : 1, fill : false, hidden : true},                            //
          {label : 'Air Quality', data : [], backgroundColor : '#803c00', borderColor : '#803c00', radius : 0, borderWidth : 1, fill : false, hidden : true},                           //
          {label : 'Precipitation', data : [], backgroundColor : '#0055FF', borderColor : '#0055FF', radius : 0, borderWidth : 1, fill : false, hidden : true, reallyHidden : true},    //
          {label : 'Snow Height', data : [], backgroundColor : '#FFFFFF', borderColor : '#FFFFFF', radius : 0, borderWidth : 1, fill : false, hidden : true, reallyHidden : true},      //
          {label : 'Water Temperature', data : [], backgroundColor : '#406cff', borderColor : '#406cff', radius : 0, borderWidth : 1, fill : false, hidden : true, reallyHidden : true}, //
          {label : 'Taille grêle (cm)', data : [], backgroundColor : '#FF3030', borderColor : '#FF3030', radius : 0, borderWidth : 1, fill : false, hidden : true},                      //
          {label : 'STP', data : [], backgroundColor : '#FF8C00', borderColor : '#FF8C00', radius : 0, borderWidth : 1, fill : false, hidden : true}                                     //
        ]
      },
      options : {
        scales : {
          x : {
            type : 'time', // Set the x-axis to use a time scale
            time : {unit : 'minute', tooltipFormat : 'HH:mm'},
            title : {
              display : true,
              color : 'white' // Make sure title color is white
            },
            ticks : {
              color : 'white' // White color for the x-axis labels
            },
            grid : {
              color : 'rgba(255, 255, 255, 0.2)' // Optional: light white for grid lines
            }
          },
          y : {
            beginAtZero : false, // Start the y-axis at 0
            ticks : {
              color : 'white'    // White color for the y-axis labels
            },
            title : {
              display : true,
              color : 'white' // Make sure title color is white
            },
            grid : {
              color : 'rgba(255, 255, 255, 0.2)' // Optional: light white for grid lines
            }
          }
        },
        plugins : {
          legend : {
            display : true,
            labels : {
              color : 'white', // White color for legend text
              font : {
                size : 14,
                family : 'Arial' // Optional: Ensure font family is set
              },
              filter : function(item, chart) { return !chart.datasets[item.datasetIndex].reallyHidden; }
            }
          }
        },
        responsive : false, // Auto rescale on canvas resize
        maintainAspectRatio : false,
        animation : false,  // Disables all animations
        normalized : true
        // parsing : false
      }
    });
  }

  updateChartJS() // add newest measurement to chart
  {
    if (this.#historyChart) {
      this.#historyChart.data.datasets[0].data.push(convertTempToSelectedUnit(this.#temperature));
      this.#historyChart.data.datasets[1].data.push(convertTempToSelectedUnit(this.#dewpoint));
      this.#historyChart.data.datasets[2].data.push(convertVelocityToSelectedUnit(this.#velocity));
      this.#historyChart.data.datasets[3].data.push(this.#airQuality);
      this.#historyChart.data.datasets[7].data.push(guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL' ? mmToIn(this.#hailSize) : this.#hailSize);
      this.#historyChart.data.datasets[8].data.push(this.#stp);

      if (this.#isOnLand) {
        this.#historyChart.data.datasets[4].data.push(guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL' ? mmToIn(this.#soilMoisture) : this.#soilMoisture);
        this.#historyChart.data.datasets[5].data.push(guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL' ? mmToIn(this.#snowHeight) : this.#snowHeight);
      } else if (this.#isOnWater) {
        this.#historyChart.data.datasets[6].data.push(convertTempToSelectedUnit(this.#waterTemperature));
      }

      this.#historyChart.data.labels.push(this.#time);

      if (this.#historyChart.data.labels.length > 60 * 24) { // max 24 hour history. Remove the oldest data and label
        this.#historyChart.data.labels.shift();
        this.#historyChart.data.datasets.forEach(dataSet => { dataSet.data.shift(); });
      }

      if (guiControls.dayNightCycle == true) {
        if (this.#chartCanvas.style.display != 'none') // only update if visible
          this.#historyChart.update();
      } else {
        this.#chartCanvas.style.display = 'none';
      }
    }
  }

  clearChart()
  {
    this.#historyChart.data.datasets.forEach(dataSet => { dataSet.data = []; });
    this.#historyChart.data.labels = [];
    this.#historyChart.update();
  }

  destroy()
  {
    this.#chartCanvas.remove();
    this.#canvas.parentElement.removeChild(this.#canvas); // remove canvas element
    let index = weatherStations.indexOf(this);
    weatherStations.splice(index, 1);                     // remove object from array
  }

  measure()
  {
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); // basetexture
    var baseTextureValues = new Float32Array(4 * 3);
    gl.readPixels(this.#x, this.#y - 1, 1, 3, gl.RGBA, gl.FLOAT, baseTextureValues);

    let T = potentialToRealT(baseTextureValues[1 * 4 + 3], this.#y); // temperature in kelvin

    this.#temperature = KtoC(T);
    this.#velocity = rawVelocityTo_ms(Math.sqrt(Math.pow(baseTextureValues[2 * 4 + 0], 2) + Math.pow(baseTextureValues[4 + 1], 2)));

    // gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
    gl.readBuffer(gl.COLOR_ATTACHMENT1); // watertexture
    var waterTextureValues = new Float32Array(2 * 4);
    gl.readPixels(this.#x, this.#y - 1, 1, 2, gl.RGBA, gl.FLOAT, waterTextureValues);

    if (waterTextureValues[4 + 0] > 1000.) { // is not air
      this.destroy();                        // remove weather station
      return;
    }

    if (waterTextureValues[0 + 0] > 1001.5) { // water wall
      this.#waterTemperature = KtoC(baseTextureValues[0 + 3]);
    } else {
      this.#waterTemperature = -100.;
    }

    this.#dewpoint = KtoC(dewpoint(waterTextureValues[4 + 0]));

    if (guiControls.realDewPoint) {
      this.#dewpoint = Math.min(this.#temperature, this.#dewpoint);
    }

    this.#relativeHumd = relativeHumd(T, waterTextureValues[4 + 0]);

    if (guiControls.realDewPoint) {
      this.#relativeHumd = Math.min(this.#relativeHumd, 100.0);
    }


    if (waterTextureValues[0] > 1000.5 && waterTextureValues[0] < 1001.5) { // on land surface
      this.#soilMoisture = waterTextureValues[2];
      this.#snowHeight = waterTextureValues[3];

      if (!this.#isOnLand) {
        this.clearChart();
        this.#isOnLand = true;
        this.#isOnWater = false;
        this.#historyChart.data.datasets[4].reallyHidden = false;
        this.#historyChart.data.datasets[5].reallyHidden = false;
        this.#historyChart.data.datasets[6].reallyHidden = true;
      }

    } else if (waterTextureValues[0] > 1001.5) { // on water surface
      if (!this.#isOnWater) {
        this.clearChart();
        this.#isOnWater = true;
        this.#isOnLand = false;
        this.#historyChart.data.datasets[4].reallyHidden = true;
        this.#historyChart.data.datasets[5].reallyHidden = true;
        this.#historyChart.data.datasets[6].reallyHidden = false;
      }
    } else { // in air
      if (this.#isOnLand || this.#isOnWater) {
        this.clearChart();
        this.#isOnLand = false;
        this.#isOnWater = false;
        this.#soilMoisture = 0;
        this.#snowHeight = 0;
        this.#waterTemperature = -10.0;
        this.#historyChart.data.datasets[4].reallyHidden = true;
        this.#historyChart.data.datasets[5].reallyHidden = true;
        this.#historyChart.data.datasets[6].reallyHidden = true;
      }
    }


    this.#airQuality = waterTextureValues[4 + 3] * 300.0; // read smoke

    // Estimate local hail diameter: no dedicated hail field exists in the sim, so this combines
    // the global CAPE reading (drives hailstone size the same way the precipitation shader does),
    // local precipitation intensity (only report hail where a storm is actually present overhead),
    // and surface temperature (melts hail down to 0 as the ground warms above freezing).
    if (guiControls.hailEnabled) {
      const capeExcess = Math.max(guiControls.CAPE - guiControls.hailCapeThreshold, 0);
      const stormFactor = clamp(waterTextureValues[4 + 2] / 2.0, 0, 1); // local precipitation channel
      let hailSizeCM = Math.min(capeExcess * 0.002, 8) * stormFactor;  // up to ~8cm for extreme CAPE
      if (this.#temperature > 0)
        hailSizeCM *= Math.max(1 - this.#temperature * 0.04, 0); // melts away as surface warms
      this.#hailSize = hailSizeCM;
    } else {
      this.#hailSize = 0;
    }

    // Proximity STP: rather than reading only the exact column under the station marker, this samples a
    // handful of columns spread across a radius around the station so the siren (which reads getSTP())
    // reacts to a tornado-favorable column APPROACHING the station, not only one sitting exactly on it.
    // Cheap to do here since measure() only runs roughly once a minute of sim time.
    const stpProximityRadius_m = 5000; // 5 km catchment radius around each station
    const stpRadiusCells = Math.max(Math.round(stpProximityRadius_m / cellHeight), 1); // cellHeight == cell width
    const stpSampleOffsets = [ -stpRadiusCells, -Math.round(stpRadiusCells / 2), 0, Math.round(stpRadiusCells / 2), stpRadiusCells ];

    let maxNearbySTP = 0;
    for (const offset of stpSampleOffsets) {
      const sampleX = clamp(this.#x + offset, 0, sim_res_x - 1);

      gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      var stpBaseValues = new Float32Array(4 * sim_res_y);
      gl.readPixels(sampleX, 0, 1, sim_res_y, gl.RGBA, gl.FLOAT, stpBaseValues);

      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      var stpWaterValues = new Float32Array(4 * sim_res_y);
      gl.readPixels(sampleX, 0, 1, sim_res_y, gl.RGBA, gl.FLOAT, stpWaterValues);

      gl.readBuffer(gl.COLOR_ATTACHMENT2);
      var stpWallValues = new Int32Array(4 * sim_res_y);
      gl.readPixels(sampleX, 0, 1, sim_res_y, gl.RGBA_INTEGER, gl.INT, stpWallValues);

      let stpSurfaceLevel = -1;
      for (let y = 0; y < sim_res_y; y++) {
        if (stpWallValues[4 * y + 1] != 0) { // first fluid (non-wall) cell = the surface
          stpSurfaceLevel = y;
          break;
        }
      }

      if (stpSurfaceLevel >= 0) {
        const parcelIndices = calcParcelIndices(stpBaseValues, stpWaterValues, stpWallValues, stpSurfaceLevel);
        const shear = calcBulkShear(stpBaseValues, stpSurfaceLevel);
        const sampleSTP = calcSTP(parcelIndices.CAPE, parcelIndices.CIN, parcelIndices.LCL_height, shear.shear06, shear.shear01);
        maxNearbySTP = Math.max(maxNearbySTP, sampleSTP);
      }
    }

    this.#stp = maxNearbySTP;

    gl.bindFramebuffer(gl.FRAMEBUFFER, lightFrameBuff_0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); // light texture
    var lightTextureValues = new Float32Array(4);
    gl.readPixels(this.#x, this.#y, 1, 1, gl.RGBA, gl.FLOAT, lightTextureValues);

    this.#netIRpow = lightTextureValues[2] - lightTextureValues[3]; // IR_DOWN - IR_UP
    // this.#netIRpow = lightTextureValues[1] / 0.000002; // or calculate from NET_HEATING

    let directSunlight = Math.max(lightTextureValues[0] * Math.sin(guiControls.sunAngle * degToRad), 0.0);

    this.#solarPower = directSunlight;

    this.#time = simDateTime.toISOString();
    this.updateChartJS(); // update chart
  }

  getXpos() { return this.#x; }

  getYpos() { return this.#y; }

  getSTP() { return this.#stp; }

  isAlarmEnabled() { return this.#alarmEnabled; }

  setHidden(hidden)
  {
    this.#mainDiv.style.display = hidden ? 'none' : 'block';
    this.#chartCanvas.style.display = 'none'; // hide charts
  }

  updateCanvas()
  {
    let screenX = simToScreenX(this.#x) - this.#width / 2;
    let screenY = simToScreenY(this.#y) - this.#height;

    // if (screenX > 0 && screenX < canvas.width && screenY > 0 && screenY < canvas.height) {
    this.#mainDiv.style.left = screenX + 'px';
    this.#mainDiv.style.top = screenY + 'px';
    // this.#canvas.style.left = screenX + 'px';
    // this.#canvas.style.top = screenY + 'px';
    let c = this.#c;
    c.clearRect(0, 0, this.#width, this.#height);
    c.fillStyle = '#00000000';
    c.fillRect(0, 0, this.#width, this.#height);

    // this station's own alarm enable/disable icon (top-right corner, click target defined by Weatherstation.#sirenIconX/Y)
    c.font = '14px Arial';
    c.fillStyle = this.#alarmEnabled ? '#FF4444' : '#888888';
    c.fillText(this.#alarmEnabled ? '🔔' : '🔕', this.#width - 20, 14);

    // temperature
    c.font = '15px Arial';
    c.fillStyle = '#FFFFFF';
    c.fillText(printTemp(this.#temperature), 30, 15);

    if (this.#displaySunAndIRPower) {
      c.font = '12px Arial';
      c.fillStyle = '#00FFFF';
      c.fillText(this.#relativeHumd.toFixed(1) + ' %', 30, 28);

      c.fillStyle = '#FFFFFF';
      c.fillText('🔅 ' + this.#solarPower.toFixed(1) + ' W/m²', 10, 40);
      c.fillStyle = '#FFFFFF';
      c.fillText('♨️' + this.#netIRpow.toFixed(1) + ' W/m²', 10, 55);
    } else {
      c.font = '12px Arial';
      c.fillStyle = '#00FFFF';
      c.fillText(printTemp(this.#dewpoint), 30, 28);

      c.fillStyle = '#FFFFFF';
      c.fillText(printVelocity(this.#velocity), 20, 40);

      if (this.#soilMoisture > 0.) {
        c.fillText(printSoilMoisture(this.#soilMoisture), 0, 52);
        c.fillText('💧', 20, 65);
      } else if (this.#waterTemperature > -1.0) {
        c.fillStyle = '#406cff';
        c.fillText(printTemp(this.#waterTemperature), 0, 52);
        c.fillText('🌊 🌡', 20, 65);
      }

      if (this.#snowHeight > 0.) {
        c.fillText(printSnowHeight(this.#snowHeight), 67, 52);
        c.font = '14px Arial';
        c.fillText('❄', 85, 65);
      }

      if (this.#hailSize > 0.2) {
        c.fillStyle = '#FF3030';
        c.font = 'bold 11px Arial';
        c.fillText('🧊 Grêle ' + printHailSize(this.#hailSize), 0, 65);
      }
    }


    // Position pointer
    c.beginPath();
    c.moveTo(this.#width / 2, this.#height * 0.80);
    c.lineTo(this.#width / 2, this.#height);
    c.strokeStyle = 'white';
    c.stroke();
    //  }
  }
}


let weatherStations = []; // array holding all weather stations


async function loadData()
{
  let file = document.getElementById('fileInput').files[0];

  if (file) {                                                    // load data from save file
    let versionBlob = file.slice(0, 4);                          // extract first 4 bytes containing version id
    let versionBuf = await versionBlob.arrayBuffer();
    let version = new Uint32Array(versionBuf)[0];                // convert to Uint32

    if (version == saveFileVersionID || version == 1939327491) { // also allow previous version, settings will not be loaded
      // check version id, only proceed if file has the right version id
      let fileArrBuf = await file.slice(4).arrayBuffer(); // slice from behind version id to
      // the end of the file
      let fileUint8Arr = new Uint8Array(fileArrBuf);        // convert to Uint8Array for pako
      let decompressed = window.pako.inflate(fileUint8Arr); // uncompress
      let dataBlob = new Blob([ decompressed ]);            // turn into blob

      let sliceStart = 0;
      let sliceEnd = 4;

      let resBlob = dataBlob.slice(sliceStart, sliceEnd); // extract first 4 bytes containing resolution
      let resBuf = await resBlob.arrayBuffer();
      resArray = new Uint16Array(resBuf);
      sim_res_x = resArray[0];
      sim_res_y = resArray[1];

      NUM_DROPLETS = (sim_res_x * sim_res_y) / NUM_DROPLETS_DEVIDER;

      saveFileName = file.name;

      if (saveFileName.includes('.')) {
        saveFileName = saveFileName.split('.').slice(0, -1).join('.'); // remove extension
      }

      console.log('loading file: ' + saveFileName);
      console.log('File versionID: ' + version);
      console.log('sim_res_x: ' + sim_res_x);
      console.log('sim_res_y: ' + sim_res_y);


      sliceStart = sliceEnd;
      sliceEnd += sim_res_x * sim_res_y * 4 * 4;
      let baseTexBlob = dataBlob.slice(sliceStart, sliceEnd);
      let baseTexBuf = await baseTexBlob.arrayBuffer();
      let baseTexF32 = new Float32Array(baseTexBuf);

      sliceStart = sliceEnd;
      sliceEnd += sim_res_x * sim_res_y * 4 * 4; // 4 * float
      let waterTexBlob = dataBlob.slice(sliceStart, sliceEnd);
      let waterTexBuf = await waterTexBlob.arrayBuffer();
      let waterTexF32 = new Float32Array(waterTexBuf);

      sliceStart = sliceEnd;
      sliceEnd += sim_res_x * sim_res_y * 4 * 1; // 4 * byte
      let wallTexBlob = dataBlob.slice(sliceStart, sliceEnd);
      let wallTexBuf = await wallTexBlob.arrayBuffer();
      let wallTexI8 = new Int8Array(wallTexBuf);

      sliceStart = sliceEnd;
      sliceEnd += NUM_DROPLETS * Float32Array.BYTES_PER_ELEMENT * 5;
      let precipArrayBlob = dataBlob.slice(sliceStart, sliceEnd);
      let precipArrayBuf = await precipArrayBlob.arrayBuffer();
      let precipArray = new Float32Array(precipArrayBuf);

      if (version == saveFileVersionID) {             // only load settings and weather stations from save file if it's the newest version with all the settings included
        sliceStart = sliceEnd;
        sliceEnd += 1 * Int16Array.BYTES_PER_ELEMENT; // one 16 bit int indicates number of weather stations
        let numWeatherStationsArrayBlob = dataBlob.slice(sliceStart, sliceEnd);
        let numWeatherStationsBuf = await numWeatherStationsArrayBlob.arrayBuffer();
        let numWeatherStations = new Int16Array(numWeatherStationsBuf)[0];

        console.log('numWeatherStations', numWeatherStations);

        sliceStart = sliceEnd;
        sliceEnd += numWeatherStations * 2 * Int16Array.BYTES_PER_ELEMENT;
        let weatherStationArrayBlob = dataBlob.slice(sliceStart, sliceEnd);
        let weatherStationBuf = await weatherStationArrayBlob.arrayBuffer();
        let weatherStationArray = new Int16Array(weatherStationBuf);


        for (i = 0; i < numWeatherStations; i++) {
          weatherStations.push(new Weatherstation(weatherStationArray[i * 2], weatherStationArray[i * 2 + 1]));
        }

        sliceStart = sliceEnd;
        let settingsArrayBlob = dataBlob.slice(sliceStart); // until end of file


        guiControlsFromSaveFile = await settingsArrayBlob.text();
      } else {
        alert('Save File from older version, settings will not be loaded');
      }

      mainScript(baseTexF32, waterTexF32, wallTexI8, precipArray);
    } else {
      // wrong id
      alert('Incompatible file!');
      document.getElementById('fileInput').value = ''; // clear file
    }
  } else {
    // no file, so create new simulation
    sim_res_x = parseInt(document.getElementById('simResSelX').value);
    sim_res_y = parseInt(document.getElementById('simResSelY').value);
    sim_height = parseInt(document.getElementById('simHeightSel').value);

    NUM_DROPLETS = (sim_res_x * sim_res_y) / NUM_DROPLETS_DEVIDER;
    SETUP_MODE = true;

    mainScript(null); // run without initial textures
  }
}

function loadImage(url)
{
  return new Promise((resolve, reject) => {
    let img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

class LoadingBar
{
  #loadingBar;
  #bar;
  #underBar;
  #percent;
  #description;

  constructor(percentIn)
  {
    if (percentIn == null)
      this.percent = 0;
    else
      this.percent = percentIn;

    // create html
    this.loadingBar = document.createElement('div');
    this.bar = document.createElement('div');
    this.loadingBar.appendChild(this.bar);

    this.underBar = document.createElement('div');
    this.loadingBar.appendChild(this.underBar);

    this.loadingBar.style.width = '100%';
    this.loadingBar.style.height = '100px';
    this.loadingBar.style.color = 'white';
    this.loadingBar.style.textAlign = 'center';
    this.loadingBar.style.lineHeight = '50px';
    this.loadingBar.style.backgroundColor = 'gray';
    this.loadingBar.style.marginTop = '400px';
    this.loadingBar.style.position = 'absolute';
    this.loadingBar.style.zIndex = '2';

    this.underBar.style.width = '100%';
    this.underBar.style.height = '50px';
    this.underBar.style.backgroundColor = 'black';

    this.bar.style.height = '50px';

    this.bar.style.backgroundColor = 'green';
    this.bar.style.fontSize = '20px';

    this.#update();

    document.body.appendChild(this.loadingBar);
  }

  async add(num, text)
  {
    this.percent += num;
    this.description = text;
    await this.#update();
  }

  async set(num, text)
  {
    this.percent = num;
    this.description = text;
    await this.#update();
  }

  async showError(error)
  {
    this.bar.style.backgroundColor = 'red';
    this.description = error;
    await this.#update();
  }

  #update()
  {
    return new Promise((resolve) => {
      this.bar.style.width = this.percent + '%';
      this.bar.innerHTML = this.percent + ' %';
      this.underBar.innerHTML = this.description;
      let timeout;
      if (this.percent == 100)
        timeout = 5;
      else
        timeout = 5; // 50 for nicer feel
      setTimeout(() => { resolve(); }, timeout);
    });
  }

  remove() { this.loadingBar.parentNode.removeChild(this.loadingBar); }
}


function setLoadingBar()
{
  return new Promise((resolve) => {
    var element = document.getElementById('IntroScreen');
    element.parentNode.removeChild(element); // remove introscreen div

    document.body.style.backgroundColor = 'black';

    loadingBar = new LoadingBar(1);

    setTimeout(() => { resolve(); }, 10);
  });
}

// ===================== Setup-screen émagramme =====================
//
// Alongside the official Meteociel graph image (#soundingPreview, fetched separately -- see
// getSoundingGraphImgUrl() and prepareSounding()), this draws a supplementary skew-T-style chart directly
// from the same REAL raw sounding table on #soundingCanvas: temperature/dewpoint curves, the lifted
// parcel path with CAPE/CIN shading, wind barbs, a small hodograph, and the CAPE/CIN/LCL/shear/STP
// readout. Always built from real archived data, never anything fabricated. Runs at setup time, before
// mainScript()/guiControls exist, so it uses guiControls_default's physics constants directly instead.

// Lifts a surface parcel through the RAW sounding table (real altitudes, not sim grid cells), using the
// exact same dry/moist adiabat model as the in-game sounding graph (calcParcelIndices further up), and
// records the path so it can be drawn. `table`: ascending pressure order (index0 = top, last = surface).
function calcParcelIndicesFromTable(table)
{
  const surface = table[table.length - 1];
  const water = maxWater(CtoK(surface.td)); // total water carried by the parcel, conserved during ascent

  let prevTempC = surface.t;
  let prevCloudWater = Math.max(water - maxWater(CtoK(prevTempC)), 0.0);
  let prevAlt = surface.alt;

  let CAPE = 0.0, CIN = 0.0;
  let LCL_height = table[0].alt; // never saturates within the table -> effectively above the whole sounding
  let foundLCL = false;
  let sawPositiveBuoyancy = false;

  const parcelPath = [ {alt : surface.alt, t : surface.t, saturated : false} ];

  for (let i = table.length - 2; i >= 0; i--) {
    const level = table[i];
    if (level.alt > guiControls_default.simHeight) // matches calcParcelIndices' own integration ceiling (bounded by sim_res_y / simHeight there); without this the raw table's much taller range (up to ~25km) inflates CAPE with spurious upper-atmosphere buoyancy the real sim never integrates over
      break;
    const dz = level.alt - prevAlt; // meters; should be positive (higher up the table)
    if (dz <= 0)                    // guards against the raw table's known near-top altitude quirk (see isPlausibleSoundingTable)
      continue;

    const drylapseC = -(dz * guiControls_default.dryLapseRate) / 1000.0;

    const cloudWaterAfterDry = Math.max(water - maxWater(CtoK(prevTempC + drylapseC)), 0.0);
    const dWt = (cloudWaterAfterDry - prevCloudWater) * guiControls_default.evapHeat;
    const TparcelC = prevTempC + dT_saturated(drylapseC, dWt);

    if (!foundLCL && cloudWaterAfterDry > 0.0) {
      foundLCL = true;
      LCL_height = level.alt;
    }

    const work = gravity * ((TparcelC - level.t) / CtoK(level.t)) * dz; // buoyant work per unit mass over this layer

    if (TparcelC > level.t) {
      CAPE += work;
      sawPositiveBuoyancy = true;
    } else if (!sawPositiveBuoyancy) {
      CIN += work; // negative: layers below the level of free convection
    }

    parcelPath.push({alt : level.alt, t : TparcelC, saturated : foundLCL});

    prevTempC = TparcelC;
    prevCloudWater = Math.max(water - maxWater(CtoK(prevTempC)), 0.0);
    prevAlt = level.alt;
  }

  return {CAPE, CIN, LCL_height, parcelPath};
}

// Bulk (speed-only) wind shear between the surface and 1km/6km AGL, sampled straight off the raw table
// via the same altitude interpolation used to blend stations together. Projects onto the sim's single
// horizontal axis (vel * cos(angle)) exactly like rawSoundingToSimSounding() will once the sim actually
// starts, so this setup-screen preview stays consistent with the real thing.
function calcBulkShearFromTable(table)
{
  const surfaceAlt = table[table.length - 1].alt;

  const uAt = (targetAlt) => {
    const row = interpolateTableAtAltitude(table, targetAlt);
    return (row.vel * Math.cos(row.angle * degToRad)) / 3.6; // km/h -> m/s
  };

  const uSurface = uAt(surfaceAlt);

  return {shear01 : Math.abs(uAt(surfaceAlt + 1000) - uSurface), shear06 : Math.abs(uAt(surfaceAlt + 6000) - uSurface)};
}

function computeSoundingIndicesFromTable(table)
{
  const parcel = calcParcelIndicesFromTable(table);
  const shear = calcBulkShearFromTable(table);
  const STP = calcSTP(parcel.CAPE, parcel.CIN, parcel.LCL_height, shear.shear06, shear.shear01);

  return {CAPE : parcel.CAPE, CIN : parcel.CIN, LCL_height : parcel.LCL_height, parcelPath : parcel.parcelPath, shear01 : shear.shear01, shear06 : shear.shear06, STP};
}

// Simplified meteorological wind barb: a shaft pointing toward where the wind comes FROM, with pennants
// (filled triangles, 50kt), full barbs (10kt) and a half-barb (5kt) ticked off the tip inward.
function drawWindBarb(ctx, x, y, speedKmh, angleDeg, color)
{
  const speedKt = speedKmh / 1.852;
  if (speedKt < 2.5) { // calm: just a small circle
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  const dirRad = angleDeg * degToRad;
  const dx = Math.sin(dirRad), dy = -Math.cos(dirRad); // screen-space unit vector toward where the wind comes from (north = up)
  const px = -dy, py = dx;                             // perpendicular, for the barb ticks

  const shaftLen = 24;
  const x2 = x + dx * shaftLen, y2 = y + dy * shaftLen;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  let remaining = Math.round(speedKt / 5) * 5;
  let pos = 1.0;    // fraction along the shaft, from the tip (1.0) toward the base (0)
  const step = 0.16;
  const tickLen = 8;

  while (remaining >= 50) {
    const bx = x + dx * shaftLen * pos, by = y + dy * shaftLen * pos;
    const bx2 = x + dx * shaftLen * (pos - step * 1.4), by2 = y + dy * shaftLen * (pos - step * 1.4);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx2, by2);
    ctx.lineTo(bx + px * tickLen, by + py * tickLen);
    ctx.closePath();
    ctx.fill();
    remaining -= 50;
    pos -= step * 1.6;
  }
  while (remaining >= 10) {
    const bx = x + dx * shaftLen * pos, by = y + dy * shaftLen * pos;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + px * tickLen, by + py * tickLen);
    ctx.stroke();
    remaining -= 10;
    pos -= step;
  }
  if (remaining >= 5) {
    const bx = x + dx * shaftLen * pos, by = y + dy * shaftLen * pos;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + px * tickLen * 0.55, by + py * tickLen * 0.55);
    ctx.stroke();
  }
}

// Wind speed (km/h) -> color, shared by the barbs and the hodograph so the two read together.
function windSpeedColor(speedKmh)
{
  const stops = [[0, '#9fb3c8'], [20, '#5ad1ff'], [45, '#6bdc7c'], [70, '#ffd36b'], [100, '#ff9050'], [140, '#ff4d6d'], [200, '#d36bff']];
  for (let i = stops.length - 1; i >= 0; i--)
    if (speedKmh >= stops[i][0])
      return stops[i][1];
  return stops[0][1];
}

// Draws the setup-screen émagramme onto #soundingCanvas from a sounding table: skewed isotherms, dry
// adiabats, the -10/-30 °C hail-growth band, environment T/Td curves, the lifted parcel with CAPE (red) /
// CIN (blue) shading, LCL / LFC / EL / 0 °C markers, pressure labels, speed-colored wind barbs, a hodograph
// colored by height, a legend, and a hover readout. Returns the computed indices.
function drawSetupEmagram(table)
{
  const canvas = document.getElementById('soundingCanvas');
  if (!canvas || !table || table.length < 2)
    return null;

  // Draw at the device's pixel density so lines and text stay crisp on high-DPI screens.
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 620, height = canvas.clientHeight || 480;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, 'rgba(8, 14, 30, 0.85)');
  bg.addColorStop(1, 'rgba(20, 34, 60, 0.75)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const marginLeft = 54, marginBottom = 30, marginRight = 68, marginTop = 8;
  const graphLeft = marginLeft, graphRight = width - marginRight, graphBottom = height - marginBottom;
  const graphWidth = graphRight - graphLeft, graphHeight = graphBottom - marginTop;
  const maxAlt = 16000; // troposphere + lower stratosphere, where CAPE/CIN/LCL actually live

  const alt_to_Y = (alt) => marginTop + clamp(map_range(alt, maxAlt, 0, 0, graphHeight), 0, graphHeight);
  // Skew-T: isotherms lean right with height
  const T_to_X = (T, screenY) => graphLeft + (T * 0.0115 + 1.18 - ((screenY - marginTop) / graphHeight) * 0.8) * graphWidth;

  ctx.save();
  ctx.beginPath();
  ctx.rect(graphLeft, marginTop, graphWidth, graphHeight);
  ctx.clip();

  const indices = computeSoundingIndicesFromTable(table);
  const surfaceAlt = table[table.length - 1].alt;

  // Hail growth zone: between the -10 °C and -30 °C environmental isotherms
  const altAtTemp = (targetT) => {
    for (let i = table.length - 1; i > 0; i--) {
      const lo = table[i], hi = table[i - 1];
      if ((lo.t - targetT) * (hi.t - targetT) <= 0 && lo.t !== hi.t)
        return lo.alt + (hi.alt - lo.alt) * (lo.t - targetT) / (lo.t - hi.t);
    }
    return null;
  };
  const hailBottom = altAtTemp(-10), hailTop = altAtTemp(-30), freezingAlt = altAtTemp(0);
  if (hailBottom !== null && hailTop !== null) {
    ctx.fillStyle = 'rgba(160, 220, 255, 0.06)';
    ctx.fillRect(graphLeft, alt_to_Y(hailTop), graphWidth, alt_to_Y(hailBottom) - alt_to_Y(hailTop));
  }

  // Altitude gridlines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  for (let alt = 0; alt <= maxAlt; alt += 1000) {
    const y = alt_to_Y(alt);
    ctx.beginPath();
    ctx.moveTo(graphLeft, y);
    ctx.lineTo(graphRight, y);
    ctx.stroke();
  }

  // Dry adiabats (θ constant): faint dashed green
  ctx.strokeStyle = 'rgba(120, 200, 140, 0.16)';
  ctx.setLineDash([ 4, 5 ]);
  for (let T0 = -40; T0 <= 120; T0 += 10) {
    ctx.beginPath();
    for (let alt = 0; alt <= maxAlt; alt += 500) {
      const y = alt_to_Y(alt), x = T_to_X(T0 - guiControls_default.dryLapseRate * alt / 1000, y);
      if (alt === 0)
        ctx.moveTo(x, y);
      else
        ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Isotherms
  ctx.lineWidth = 1;
  for (let T = -100; T <= 50; T += 10) {
    ctx.strokeStyle = T === 0 ? 'rgba(90, 190, 255, 0.55)' : 'rgba(200, 150, 90, 0.18)';
    ctx.lineWidth = T === 0 ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(T_to_X(T, graphBottom), graphBottom);
    ctx.lineTo(T_to_X(T, marginTop), marginTop);
    ctx.stroke();
  }

  // CAPE (red) / CIN (blue) shading between the parcel path and the environment, layer by layer
  for (let i = 1; i < indices.parcelPath.length; i++) {
    const prevParcel = indices.parcelPath[i - 1], curParcel = indices.parcelPath[i];
    const envRow = interpolateTableAtAltitude(table, curParcel.alt);
    const prevEnvRow = interpolateTableAtAltitude(table, prevParcel.alt);

    ctx.fillStyle = curParcel.t > envRow.t ? 'rgba(255, 70, 90, 0.30)' : 'rgba(70, 130, 255, 0.22)';

    const y1 = alt_to_Y(prevParcel.alt), y2 = alt_to_Y(curParcel.alt);
    ctx.beginPath();
    ctx.moveTo(T_to_X(prevParcel.t, y1), y1);
    ctx.lineTo(T_to_X(curParcel.t, y2), y2);
    ctx.lineTo(T_to_X(envRow.t, y2), y2);
    ctx.lineTo(T_to_X(prevEnvRow.t, y1), y1);
    ctx.closePath();
    ctx.fill();
  }

  const drawCurve = (key, color, glow) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let i = table.length - 1; i >= 0; i--) {
      if (table[i].alt > maxAlt + 2000)
        break;
      const y = alt_to_Y(table[i].alt);
      if (i == table.length - 1)
        ctx.moveTo(T_to_X(table[i][key], y), y);
      else
        ctx.lineTo(T_to_X(table[i][key], y), y);
    }
    ctx.stroke();
    ctx.restore();
  };
  drawCurve('td', '#3d8bff', 'rgba(61, 139, 255, 0.8)');
  drawCurve('t', '#ff4d5e', 'rgba(255, 77, 94, 0.8)');

  // Parcel path: dry part dashed, saturated part solid
  ctx.lineWidth = 2;
  for (let i = 1; i < indices.parcelPath.length; i++) {
    const a = indices.parcelPath[i - 1], b = indices.parcelPath[i];
    ctx.strokeStyle = b.saturated ? '#7dff8a' : '#3fbf55';
    ctx.setLineDash(b.saturated ? [] : [ 6, 4 ]);
    ctx.beginPath();
    ctx.moveTo(T_to_X(a.t, alt_to_Y(a.alt)), alt_to_Y(a.alt));
    ctx.lineTo(T_to_X(b.t, alt_to_Y(b.alt)), alt_to_Y(b.alt));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // LFC / EL from the parcel path
  let LFC = null, EL = null;
  for (let i = 1; i < indices.parcelPath.length; i++) {
    const p = indices.parcelPath[i];
    const buoyant = p.t > interpolateTableAtAltitude(table, p.alt).t;
    if (buoyant && LFC === null && p.saturated)
      LFC = p.alt;
    if (buoyant)
      EL = p.alt;
  }
  if (LFC === null)
    EL = null;

  // Level markers
  const markers = [
    {alt : indices.LCL_height, label : 'LCL', color : '#7dff8a', show : indices.LCL_height < maxAlt},
    {alt : LFC, label : 'LFC', color : '#ffd36b', show : LFC !== null},
    {alt : EL, label : 'EL', color : '#ff8fa0', show : EL !== null && EL > (LFC || 0) + 300},
    {alt : freezingAlt, label : '0 °C', color : '#5abeff', show : freezingAlt !== null},
  ];
  ctx.font = '600 11px Inter, Arial, sans-serif';
  const placedLabels = []; // {y, right}: labels of nearby levels (e.g. LCL and LFC) are put side by side instead of on top of each other
  for (const m of markers) {
    if (!m.show)
      continue;
    const y = alt_to_Y(m.alt);
    let labelX = graphLeft + 74;
    for (const placed of placedLabels)
      if (Math.abs(placed.y - y) < 12)
        labelX = Math.max(labelX, placed.right + 8);
    placedLabels.push({y, right : labelX + ctx.measureText(m.label).width});
    ctx.strokeStyle = m.color;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([ 2, 4 ]);
    ctx.beginPath();
    ctx.moveTo(graphLeft, y);
    ctx.lineTo(graphLeft + 70, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = m.color;
    ctx.fillText(m.label, labelX, y + 4);
  }

  if (hailBottom !== null && hailTop !== null) {
    ctx.fillStyle = 'rgba(160, 220, 255, 0.45)';
    ctx.font = '10px Inter, Arial, sans-serif';
    ctx.fillText('zone de croissance de la grêle', graphLeft + 6, alt_to_Y(hailTop) + 12);
  }

  ctx.restore(); // end clip

  // Axes labels: altitude (left), temperature (bottom), pressure (right of the graph)
  ctx.font = '11px Inter, Arial, sans-serif';
  ctx.fillStyle = 'rgba(226, 236, 255, 0.6)';
  ctx.textAlign = 'right';
  for (let alt = 0; alt <= maxAlt; alt += 2000)
    ctx.fillText((alt / 1000) + ' km', graphLeft - 8, alt_to_Y(alt) + 4);
  ctx.textAlign = 'center';
  for (let T = -40; T <= 40; T += 10) {
    const x = T_to_X(T, graphBottom);
    if (x > graphLeft + 10 && x < graphRight - 10)
      ctx.fillText(printTemp(T), x, height - 10);
  }
  ctx.textAlign = 'right';
  for (const p of [ 850, 700, 500, 300, 200 ]) { // inside the plot's right edge, below the hodograph inset
    const row = table.find(r => r.p === p);
    if (!row || row.alt > maxAlt)
      continue;
    const y = alt_to_Y(row.alt);
    if (y < marginTop + 160)
      continue;
    ctx.fillStyle = 'rgba(226, 236, 255, 0.35)';
    ctx.fillText(p + ' hPa', graphRight - 6, y - 3);
  }
  ctx.textAlign = 'left';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.strokeRect(graphLeft + 0.5, marginTop + 0.5, graphWidth, graphHeight);

  // Wind barbs, colored by speed, thinned so they never overlap
  let lastBarbY = Infinity;
  for (let i = table.length - 1; i >= 0; i--) {
    const row = table[i];
    if (row.alt > maxAlt)
      break;
    const y = alt_to_Y(row.alt);
    if (lastBarbY - y < 16)
      continue;
    lastBarbY = y;
    drawWindBarb(ctx, graphRight + 36, y, row.vel, row.angle, windSpeedColor(row.vel));
  }

  // Hodograph inset: u/v wind by height, colored by height band (0-3 km, 3-6 km, 6-9 km, 9 km+)
  const hodoSize = 132, hodoX = graphRight - hodoSize - 6, hodoY = marginTop + 6, hodoR = hodoSize / 2 - 12;
  const hcx = hodoX + hodoSize / 2, hcy = hodoY + hodoSize / 2;
  ctx.fillStyle = 'rgba(6, 12, 24, 0.75)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(hodoX, hodoY, hodoSize, hodoSize, 10) : ctx.rect(hodoX, hodoY, hodoSize, hodoSize);
  ctx.fill();
  ctx.stroke();

  const hodoRows = table.filter(r => r.alt - surfaceAlt <= 12000);
  const maxSpeed = Math.max(...hodoRows.map(r => r.vel), 20);
  const ringStep = maxSpeed > 120 ? 50 : 20;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.fillStyle = 'rgba(226, 236, 255, 0.35)';
  ctx.font = '9px Inter, Arial, sans-serif';
  for (let s = ringStep; s <= maxSpeed; s += ringStep) {
    const r = s / maxSpeed * hodoR;
    ctx.beginPath();
    ctx.arc(hcx, hcy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(s, hcx + r * 0.7 + 2, hcy - r * 0.7);
  }
  ctx.beginPath();
  ctx.moveTo(hcx - hodoR, hcy);
  ctx.lineTo(hcx + hodoR, hcy);
  ctx.moveTo(hcx, hcy - hodoR);
  ctx.lineTo(hcx, hcy + hodoR);
  ctx.stroke();

  const hodoColors = [ '#ff4d6d', '#6bdc7c', '#ffd36b', '#5ad1ff' ];
  ctx.lineWidth = 2;
  for (let i = hodoRows.length - 1; i > 0; i--) {
    const a = hodoRows[i], b = hodoRows[i - 1];
    const pt = r => {
      const k = hodoR / maxSpeed;
      return [ hcx - r.vel * Math.sin(r.angle * degToRad) * k, hcy + r.vel * Math.cos(r.angle * degToRad) * k ]; // vector the wind blows TOWARD
    };
    const [x1, y1] = pt(a), [x2, y2] = pt(b);
    ctx.strokeStyle = hodoColors[Math.min(Math.floor((b.alt - surfaceAlt) / 3000), 3)];
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(226, 236, 255, 0.55)';
  ctx.font = '600 9px Inter, Arial, sans-serif';
  ctx.fillText('HODOGRAPHE km/h', hodoX + 8, hodoY + hodoSize - 7);

  // Legend
  const legend = [ [ '#ff4d5e', 'Température' ], [ '#3d8bff', 'Point de rosée' ], [ '#7dff8a', 'Particule' ] ];
  ctx.font = '11px Inter, Arial, sans-serif';
  let lx = graphLeft + 8;
  const ly = graphBottom - 10;
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 4, 14, 3);
    ctx.fillStyle = 'rgba(226, 236, 255, 0.75)';
    ctx.fillText(label, lx + 19, ly);
    lx += 26 + ctx.measureText(label).width;
  }

  // Hover readout: keep what's needed on the canvas, attach the listener once
  canvas.__emagram = {table, alt_to_Y, marginTop, graphHeight, graphLeft, graphRight, maxAlt, snapshot : ctx.getImageData(0, 0, canvas.width, canvas.height)}; // restored on every hover move
  if (!canvas.__hoverAttached) {
    canvas.__hoverAttached = true;
    canvas.addEventListener('mouseleave', () => {
      const e = canvas.__emagram;
      if (e)
        canvas.getContext('2d').putImageData(e.snapshot, 0, 0);
    });
    canvas.addEventListener('mousemove', event => {
      const e = canvas.__emagram;
      if (!e)
        return;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left, my = event.clientY - rect.top;
      const c = canvas.getContext('2d');
      c.putImageData(e.snapshot, 0, 0);
      if (my < e.marginTop || my > e.marginTop + e.graphHeight || mx < e.graphLeft || mx > e.graphRight)
        return;
      const alt = map_range(my - e.marginTop, 0, e.graphHeight, e.maxAlt, 0);
      if (alt < e.table[e.table.length - 1].alt)
        return;
      const row = interpolateTableAtAltitude(e.table, alt);
      const d = window.devicePixelRatio || 1;
      c.setTransform(d, 0, 0, d, 0, 0);
      c.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(e.graphLeft, my);
      c.lineTo(e.graphRight, my);
      c.stroke();
      const lines = [ (alt / 1000).toFixed(1) + ' km · ' + Math.round(row.p) + ' hPa', 'T ' + printTemp(row.t) + '   Td ' + printTemp(row.td), 'Vent ' + Math.round(row.angle) + '° · ' + Math.round(row.vel) + ' km/h' ];
      c.font = '12px Inter, Arial, sans-serif';
      const w = Math.max(...lines.map(l => c.measureText(l).width)) + 16, h = lines.length * 16 + 10;
      const bx = mx + w + 14 > e.graphRight ? mx - w - 10 : mx + 10, by = clamp(my - h - 8, e.marginTop, e.marginTop + e.graphHeight - h);
      c.fillStyle = 'rgba(8, 14, 30, 0.92)';
      c.fillRect(bx, by, w, h);
      c.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      c.strokeRect(bx + 0.5, by + 0.5, w, h);
      c.fillStyle = '#ffffff';
      lines.forEach((l, i) => c.fillText(l, bx + 8, by + 20 + i * 16));
    });
  }

  return Object.assign(indices, {LFC, EL, freezingAlt});
}

var soundingData;

var prepareSoundingRequestId = 0; // guards against overlapping calls (e.g. fast clicking through dates) resolving out of order

// Fetches meteociel's own official graph image and shows it in #soundingPreview, only for a sounding that
// actually came from the meteociel archive. Best-effort, guarded by the request id so a slow, now-stale
// image fetch can't clobber a newer selection.
async function loadAndShowRealImage(stationID, timeStamp, requestId)
{
  const imgEl = document.getElementById('soundingPreview');
  if (!imgEl)
    return;

  const url = await getSoundingGraphImgUrl(stationID, timeStamp);

  if (requestId !== prepareSoundingRequestId || !url)
    return;

  imgEl.src = url;
  imgEl.hidden = false;
}

// Fills the home-screen index tiles (#soundingStats) from computeSoundingIndicesFromTable()'s result, each
// tile colored by how favorable that value is for severe convection.
function renderSoundingStats(indices, table)
{
  const statsEl = document.getElementById('soundingStats');
  if (!statsEl)
    return;

  statsEl.innerHTML = '';
  if (!indices)
    return;

  const surface = table[table.length - 1];
  let freezingAlt = null;
  for (let i = table.length - 1; i > 0; i--) {
    if (table[i].t > 0 && table[i - 1].t <= 0) {
      freezingAlt = table[i].alt + (table[i - 1].alt - table[i].alt) * table[i].t / (table[i].t - table[i - 1].t);
      break;
    }
  }

  const level = (value, thresholds) => value >= thresholds[2] ? 'extreme' : value >= thresholds[1] ? 'high' : value >= thresholds[0] ? 'moderate' : 'low';

  const tiles = [
    {label : 'CAPE', value : indices.CAPE.toFixed(0) + ' J/kg', level : level(indices.CAPE, [ 300, 1000, 2500 ])},
    {label : 'CIN', value : indices.CIN.toFixed(0) + ' J/kg', level : indices.CIN < -150 ? 'moderate' : 'low'},
    {label : 'LCL', value : printAltitude(indices.LCL_height - surface.alt), level : 'neutral'},
    {label : 'LFC → EL', value : indices.LFC != null ? printAltitude(indices.LFC) + ' → ' + printAltitude(indices.EL) : '—', level : indices.EL != null && indices.EL > 10000 ? 'high' : 'neutral'},
    {label : 'Cisaillement 0-6 km', value : printVelocity(indices.shear06), level : level(indices.shear06, [ 10, 18, 25 ])},
    {label : 'STP', value : indices.STP.toFixed(2), level : level(indices.STP, [ 0.3, 1, 3 ])},
    {label : 'T / Td sol', value : printTemp(surface.t) + ' / ' + printTemp(surface.td), level : 'neutral'},
    {label : 'Isotherme 0 °C', value : freezingAlt !== null ? printAltitude(freezingAlt) : '—', level : 'neutral'},
  ];

  for (const tile of tiles) {
    const el = document.createElement('div');
    el.className = 'stat-tile stat-' + tile.level;
    const labelEl = document.createElement('span');
    labelEl.className = 'stat-label';
    labelEl.textContent = tile.label;
    const valueEl = document.createElement('span');
    valueEl.className = 'stat-value';
    valueEl.textContent = tile.value;
    el.appendChild(labelEl);
    el.appendChild(valueEl);
    statsEl.appendChild(el);
  }
}

async function prepareSounding()
{
  const requestId = ++prepareSoundingRequestId;

  const loc = soundingLocation;
  if (!loc)
    return;

  const dateSel = document.getElementById('datePicker');
  const hourSelector = document.getElementById('hourSelector');
  const epochTime = parseIsoDateToEpoch(dateSel.value, hourSelector.value);

  const statusEl = document.getElementById('soundingStatus');
  const titleEl = document.getElementById('soundingTitle');
  const imgEl = document.getElementById('soundingPreview');
  const cardEl = document.getElementById('stations-section');

  function setStatus(text, kind)
  {
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.appendChild(svgIcon({success : 'check', error : 'alert', loading : 'loader'}[kind]));
      statusEl.appendChild(document.createTextNode(text.replace(/^[✓⚠]\s*/, '')));
      statusEl.className = 'sounding-status ' + kind;
    }
    if (cardEl)
      cardEl.classList.toggle('is-loading', kind === 'loading');
  }

  function showNoData(message)
  {
    setStatus(message, 'error');
    renderSoundingStats(null);
    const canvas = document.getElementById('soundingCanvas');
    if (canvas)
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); // no stale/fabricated graph left on screen
  }

  if (imgEl)
    imgEl.hidden = true; // hidden until a real image URL actually resolves below -- never shows a broken icon

  if (epochTime === null) {
    if (titleEl)
      titleEl.textContent = loc.label;
    showNoData('⚠ Date invalide (format attendu : AAAA-MM-JJ).');
    return;
  }

  if (titleEl)
    titleEl.textContent = loc.label + ' · ' + formatSoundingTime(epochTime);

  lastSoundingEpochTime = epochTime; // seeds the in-game date/hour widget

  if (isBeyondForecastRange(epochTime)) {
    showNoData('⚠ Les prévisions ne vont que jusqu\'à ' + SOUNDING_MAX_FORECAST_DAYS + ' jours.');
    return;
  }

  setStatus('Chargement du sondage pour ' + loc.label + '…', 'loading');

  const result = await loadSoundingAt(loc, epochTime);

  if (requestId !== prepareSoundingRequestId)
    return; // a newer call already superseded this one

  if (!result) {
    if (epochTime < OPEN_METEO_START_EPOCH)
      showNoData(loc.id ? '⚠ Avant le 23/03/2021, seule l\'archive Meteociel existe — elle bloque actuellement les requêtes automatiques. Choisissez une date plus récente.'
                        : '⚠ Pas de données modèle avant le 23/03/2021. Choisissez une date plus récente.');
    else
      showNoData('⚠ Sondage indisponible pour le moment (connexion ?). Réessayez dans un instant.');
    return;
  }

  soundingData = result.table;
  if (loc.key)
    guiControls.activeSoundingStation = loc.key; // keeps the in-game station switcher in sync

  renderSoundingStats(drawSetupEmagram(result.table), result.table);
  setStatus('✓ ' + soundingSourceLabel(result.source) + ' — ' + formatLatLon(loc.lat, loc.lon), 'success');

  if (result.source === 'meteociel')
    await loadAndShowRealImage(loc.id, epochTime, requestId);
}

async function mainScript(initialBaseTex, initialWaterTex, initialWallTex, initialRainDrops)
{


  await setLoadingBar();

  let lastSaveTime = new Date();

  class Camera
  {
    #spring = 0.02;   // 0.02
    #damp = 0.70;     // 0.70
    wrapHorizontally; // bool
    smooth;           // bool
    curXpos;
    curXposLin;
    curYpos;
    curZoom;
    tarXpos;
    tarYpos;
    tarZoom;
    #Xvel;
    #Yvel;
    #Zvel;

    constructor()
    {
      this.curXpos = 0;
      this.curXposLin = 0;
      this.curYpos = -0.5 + sim_res_y / sim_res_x; // viewYpos = -0.5 + sim_res_y / sim_res_x;// match bottem of sim area to bottem of screen
      this.curZoom = 1.0001;
      this.tarXpos = 0;
      this.tarYpos = -0.5 + sim_res_y / sim_res_x;
      this.tarZoom = 1.0001;
      this.wrapHorizontally = true;
      this.smooth = true;
      this.#Xvel = 0;
      this.#Yvel = 0;
      this.#Zvel = 0;
    }

    center()
    {
      this.tarXpos = this.curXpos = this.curXposLin = 0.0;
      this.tarYpos = this.curYpos = -0.5 + sim_res_y / sim_res_x;
      this.tarZoom = this.curZoom = 1.0001;
      this.#Xvel = 0;
      this.#Yvel = 0;
      this.#Zvel = 0;
    }

    changeCurXpos(change)
    {
      this.curXposLin = this.curXposLin + change;
      this.curXpos = mod(this.curXposLin + 1.0, 2.0) - 1.0;
    }

    setPosition(x, y, zoom)
    {
      this.curXpos = this.tarXpos = x;
      this.curYpos = this.tarYpos = y;

      if (zoom)
        this.curZoom = this.tarZoom = zoom;
    }

    move()
    {
      let xDif = this.tarXpos - this.curXposLin;
      let yDif = this.tarYpos - this.curYpos;
      let zoomDif = this.tarZoom - this.curZoom;
      if (this.smooth) {
        this.#Xvel += xDif * this.#spring;
        this.#Xvel *= this.#damp;
        this.changeCurXpos(this.#Xvel);

        this.#Yvel += yDif * this.#spring;
        this.#Yvel *= this.#damp;
        this.curYpos += this.#Yvel;

        this.#Zvel += zoomDif * this.#spring;
        this.#Zvel *= this.#damp;
        this.curZoom += this.#Zvel;
      } else {
        this.changeCurXpos(xDif);
        this.curYpos += yDif;
        this.curZoom += zoomDif;
      }

      if (guiControls.sound && !guiControls.paused) {
        soundSystem.updateAmbientSound(this.curXpos, this.curYpos, this.curZoom);
      }
    }

    changeViewZoom(change)
    {
      this.tarZoom *= 1.0 + change;

      let minZoom = 0.5;
      let maxZoom = 35.0 * sim_aspect;

      if (this.tarZoom > maxZoom) {
        this.tarZoom = maxZoom;
        return false;
      } else if (this.tarZoom < minZoom) {
        this.tarZoom = minZoom;
        return false;
      } else {
        return true;
      }
    }

    changeViewXpos(change)
    {
      this.tarXpos += change;
      if (!this.wrapHorizontally)
        this.tarXpos = clamp(this.tarXpos, -0.99, 0.99);
    }

    changeViewYpos(change) { this.tarYpos = clamp(this.tarYpos + change, -2.50, 0.50); }

    zoomAtMousePos(delta)
    {
      if (cam.changeViewZoom(delta)) {
        // zoom center at mouse position
        var mousePositionZoomCorrectionX = (((mouseX - canvas.width / 2 + this.tarXpos) * delta) / cam.tarZoom / canvas.width) * 2.0;
        var mousePositionZoomCorrectionY = ((((mouseY - canvas.height / 2 + this.tarYpos) * delta) / cam.tarZoom / canvas.height) * 2.0) / canvas_aspect;
        this.changeViewXpos(-mousePositionZoomCorrectionX);
        this.changeViewYpos(mousePositionZoomCorrectionY);
      }
    }
  }

  cam = new Camera();

  class JetEngineSoundGenerator
  {
    constructor(ctx) { this.audioCtx = ctx; }

    createSource(bufferSize)
    {
      const bufferSource = this.audioCtx.createBufferSource();
      bufferSource.buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
      return bufferSource;
    }

    createLowNoiseSource()
    {
      const bufferSize = 20 * this.audioCtx.sampleRate;
      const bufferSource = this.createSource(bufferSize);
      const data = bufferSource.buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i += 2)
        data[i] = Math.random() * 2 - 1;
      for (let i = 1; i < bufferSize - 1; i += 2)   // Fill in the gaps
        data[i] = (data[i - 1] + data[i + 1]) / 2.; // average of surrounding samples
      return bufferSource;
    }

    start()
    {
      // High-pitch turbine whine
      this.lowWhine = this.audioCtx.createOscillator();
      this.lowWhine.type = "sine";
      this.lowWhineGain = this.audioCtx.createGain();

      this.highWhine = this.audioCtx.createOscillator();
      this.highWhine.type = "sine";
      this.highWhineGain = this.audioCtx.createGain();

      // low rumble noise
      this.lowNoiseSource = this.createLowNoiseSource();
      this.lowNoiseSource.loop = true;
      this.lowNoiseFilter = this.audioCtx.createBiquadFilter();
      this.lowNoiseFilter.type = "lowpass";
      this.lowNoiseFilter.Q.value = 5.5;
      this.lowNoiseGain = this.audioCtx.createGain();

      // stereo pan
      this.pan = this.audioCtx.createStereoPanner();

      // Master mix
      this.mix = this.audioCtx.createGain();
      this.mix.gain.value = 0.;

      // Connect graph
      this.lowWhine.connect(this.lowWhineGain).connect(this.mix);
      this.highWhine.connect(this.highWhineGain).connect(this.mix);
      this.lowNoiseSource.connect(this.lowNoiseFilter).connect(this.lowNoiseGain).connect(this.mix);
      this.mix.connect(this.pan).connect(this.audioCtx.destination);

      // Start
      this.lowWhine.start();
      this.highWhine.start();
      this.lowNoiseSource.start();
    }

    update(N1, dist, horizontalAngle)
    {
      const rpm = N1 * 7000;
      const whineFreq = 100 + rpm * 1.0; // 300 + rpm * 0.8;
      const noiseFreq = N1 * 600;        // 200 + N1 * 300;

      this.lowWhine.frequency.value = whineFreq / 2.;
      this.highWhine.frequency.value = whineFreq;
      this.lowNoiseFilter.frequency.value = noiseFreq;

      const airVol = Math.sqrt(N1) * 3.;
      const whineVol = Math.sqrt(Math.min(N1, 0.3)) * 0.005;

      this.lowNoiseGain.gain.value = airVol;
      this.lowWhineGain.gain.value = whineVol;
      this.highWhineGain.gain.value = whineVol;

      dist += 1.0; // prevent devide by 0

      this.pan.pan.value = -horizontalAngle / 90.;
      this.mix.gain.value = 170.0 / dist;
    }

    mute()
    {
      if (this.mix)
        this.mix.gain.value = 0.;
    }

    stop()
    {
      this.mix.gain.value = 0;
      this.lowWhine.stop();
      this.highWhine.stop();
      this.lowNoiseSource.stop();
    }
  }

  class SoundSystem
  {
    audioCtx;
    jetEngineSound;

    thunderCCSounds = [];
    thunderCGSounds = [];

    urban_sound;
    forest_sound;
    beach_sound;
    rain_sound;
    wind_sound;
    hail_light_sound;
    hail_heavy_sound;
    hailAudible = false; // tracks whether hail sound is currently playing, so we only log on state changes
    tornado_siren_sound;
    sirenAudible = false; // tracks whether the siren is currently playing, so we only log on state changes


    constructor()
    {
      this.audioCtx = new window.AudioContext();
      this.jetEngineSound = new JetEngineSoundGenerator(this.audioCtx);
      // load sound files asynchronously
      this.loadThunderSounds('cc', 13).then(buffers => { this.thunderCCSounds = buffers; });
      this.loadThunderSounds('cg', 13).then(buffers => { this.thunderCGSounds = buffers; });

      this.loadSound('urban.m4a').then(buffer => { this.urban_sound = this.playLoop(buffer, 0.0); });
      this.loadSound('forest.mp3').then(buffer => { this.forest_sound = this.playLoop(buffer, 0.0); });
      this.loadSound('beach.mp3').then(buffer => { this.beach_sound = this.playLoop(buffer, 0.0); });
      this.loadSound('rain.m4a').then(buffer => { this.rain_sound = this.playLoop(buffer, 0.0); });
      this.loadSound('wind.m4a').then(buffer => { this.wind_sound = this.playLoop(buffer, 0.0); });
      this.loadSound('hail_light.mp3')
        .then(buffer => {
          this.hail_light_sound = this.playLoop(buffer, 0.0);
          console.log('[hail audio] resources/sounds/hail_light.mp3 loaded OK, duration:', buffer.duration.toFixed(2) + 's');
        })
        .catch(err => { console.error('Erreur chargement hail_light:', err); });

      this.loadSound('hail_heavy.mp3')
        .then(buffer => {
          this.hail_heavy_sound = this.playLoop(buffer, 0.0);
          console.log('[hail audio] resources/sounds/hail_heavy.mp3 loaded OK, duration:', buffer.duration.toFixed(2) + 's');
        })
        .catch(err => { console.error('Erreur chargement hail_heavy:', err); });

      this.loadSound('tornado_siren.mp3')
        .then(buffer => {
          this.tornado_siren_sound = this.playLoop(buffer, 0.0);
          console.log('[siren audio] resources/sounds/tornado_siren.mp3 loaded OK, duration:', buffer.duration.toFixed(2) + 's');
        })
        .catch(err => { console.error('Erreur chargement tornado_siren:', err); });

      // Browsers suspend a freshly-created AudioContext until a real user gesture (click/keydown) resumes it.
      // The context is normally created during app startup, which can happen too far from the "Create
      // Simulation" click (after several awaited loading steps) for the browser to count it as the same
      // gesture, silently leaving all sounds muted. Unlock explicitly on the next user interaction.
      if (this.audioCtx.state === 'suspended') {
        const unlock = () => {
          this.audioCtx.resume().then(() => { console.log('[hail audio] AudioContext unlocked by user interaction, state:', this.audioCtx.state); });
          window.removeEventListener('click', unlock);
          window.removeEventListener('keydown', unlock);
        };
        window.addEventListener('click', unlock);
        window.addEventListener('keydown', unlock);
        console.log('[hail audio] AudioContext started suspended, waiting for a click or keypress to unlock it.');
      }
    }

    async loadSound(url)
    {
      const path = 'resources/sounds/' + url;
      const resp = await fetch(path);

      if (!resp.ok) // fetch() only rejects on network failure, not on 404/500 -- check the status explicitly
        throw new Error(`HTTP ${resp.status} ${resp.statusText} fetching ${path}`);

      const arrayBuffer = await resp.arrayBuffer();

      try {
        return await this.audioCtx.decodeAudioData(arrayBuffer);
      } catch (decodeErr) {
        throw new Error(`decodeAudioData failed for ${path}: ${decodeErr.message || decodeErr}`);
      }
    }

    async loadThunderSounds(name, num)
    {
      const soundPromises = [];
      for (let i = 1; i <= num; i++) {
        const filename = name + `${i}.m4a`;
        soundPromises.push(this.loadSound(filename));
      }
      return await Promise.all(soundPromises);
    }

    soundThunder(x, y, intensity)
    {
      let camXnorm = 1. - (cam.curXpos + 1.0) / 2.0;

      let camDistFromSim = cellHeight * sim_res_x * 0.5 / cam.curZoom; // asuming 90° HFOV

      let camHorDistFromStrike = (x - camXnorm) * cellHeight * sim_res_x;

      let vecStrikeToCam = new Vec2D(camDistFromSim, camHorDistFromStrike);

      let distance = vecStrikeToCam.mag();

      let leftRightBalance = -vecStrikeToCam.angle();

      // console.log(camDistFromSim, camHorDistFromStrike, distance, leftRightBalance);

      // Speed of sound ≈ 343 m/s
      let soundDelay = distance / 343;                                            // in seconds

      let simTimeMult = timePerIteration * guiControls.IterPerFrame * FPS * 3600; // how much faster sime time is than real time

      soundDelay /= simTimeMult;

      let soundArray = intensity > 1.0 ? this.thunderCGSounds : this.thunderCCSounds;
      let randomThunderSound = soundArray[Math.floor(Math.random() * soundArray.length)];
      this.playOnce(randomThunderSound, intensity / (distance * 0.001), leftRightBalance, soundDelay);
    }

    playOnce(buffer, volume = 1, leftRightBalance = 0, delay = 0)
    {
      const src = this.audioCtx.createBufferSource();
      const gain = this.audioCtx.createGain();
      const pan = this.audioCtx.createStereoPanner();
      src.buffer = buffer;
      src.loop = false;
      gain.gain.value = volume;
      pan.pan.value = clamp(leftRightBalance, -1., 1.);
      src.connect(gain).connect(pan).connect(this.audioCtx.destination);
      src.start(this.audioCtx.currentTime + (Number.isFinite(delay) ? Math.max(delay, 0) : 0)); // delay is Infinity/NaN while the sim is paused
    }

    playLoop(buffer, volume = 1, leftRightBalance = 0)
    {
      const src = this.audioCtx.createBufferSource();
      const gain = this.audioCtx.createGain();
      const pan = this.audioCtx.createStereoPanner();
      src.buffer = buffer;
      src.loop = true;
      gain.gain.value = volume;
      pan.pan.value = clamp(leftRightBalance, -1., 1.);
      src.connect(gain).connect(pan).connect(this.audioCtx.destination);
      src.start();
      return {gain : gain.gain, pan : pan.pan};
    }

    updateAmbientSound(Xpos, Ypos, zoom)
    {
      let camDistFromSim = cellHeight * sim_res_x * 0.5 / zoom; // asuming 90° HFOV

      if (camDistFromSim < 5000) {

        const sampleWidth = Math.floor(clamp(camDistFromSim / cellHeight * 3, 30, 200)); // sample just a litte wider than the fov
        const sampleWidth_2 = Math.floor(sampleWidth / 2);
        const sampleWidth_3 = Math.floor(sampleWidth / 3);

        let simXpos = Math.floor((-Xpos + 1) * 0.5 * sim_res_x);
        let simYpos = clamp(Math.floor((-Ypos * sim_aspect + 1) * 0.5 * sim_res_y), 0, sim_res_y - 1);

        gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
        gl.readBuffer(gl.COLOR_ATTACHMENT2); // walltexture
        var wallTextureValues = new Int8Array(4 * sampleWidth);
        gl.readPixels(simXpos - sampleWidth_2, simYpos, sampleWidth, 1, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues);

        let cellsAboveSurface = wallTextureValues[sampleWidth_2 * 4 + 2];

        let camHeightAboveSurface = cellsAboveSurface * cellHeight;

        let vecCamToSurface = new Vec2D(camDistFromSim, camHeightAboveSurface);

        let distanceToSurface = vecCamToSurface.mag();

        let forest = new Vec2D();
        let beach = new Vec2D();
        let urban = new Vec2D();

        let distVolumeMult = map_range_C(1.0 / (clamp(distanceToSurface, 1000, 5000) / 1000.0), 0.2, 1.0, 0.0, 1.0); // multiplier based on camera distance to surface

        for (let i = 0; i < sampleWidth; i++) {

          let Lgain = clamp((sampleWidth_3 - Math.abs(i - sampleWidth_3)) / (sampleWidth_3 * sampleWidth_3), 0., 1.);
          let Rgain = clamp((sampleWidth_3 - Math.abs(i - sampleWidth_3 * 2)) / (sampleWidth_3 * sampleWidth_3), 0., 1.);
          let gain = new Vec2D(Lgain, Rgain);

          if (wallTextureValues[i * 4 + 0] == 1) { // land vegetation
            let vegetationNorm = wallTextureValues[i * 4 + 3] / 127.0;
            forest.add(gain.mult(vegetationNorm));
          } else if (wallTextureValues[i * 4 + 0] == 2) {                                      // water
            beach.add(gain);
          } else if (wallTextureValues[i * 4 + 0] == 4 || wallTextureValues[i * 4 + 0] == 6) { // urban or industrial
            urban.add(gain);
          }
        }

        forest.mult(distVolumeMult * 0.15);
        beach.mult(distVolumeMult * 1.0);
        urban.mult(distVolumeMult * 1.0);

        this.setSoundLeftRight(this.forest_sound, forest.x, forest.y);
        this.setSoundLeftRight(this.beach_sound, beach.x, beach.y);
        this.setSoundLeftRight(this.urban_sound, urban.x, urban.y);

        // wind sound
        gl.readBuffer(gl.COLOR_ATTACHMENT0); // basetexture
        var baseTextureValues = new Float32Array(4);
        let justAboveSurfaceCellY = simYpos - cellsAboveSurface + 3;
        gl.readPixels(simXpos, justAboveSurfaceCellY, 1, 1, gl.RGBA, gl.FLOAT, baseTextureValues); // read single cell at mouse position

        let windVolume = Math.abs(baseTextureValues[0]) * 10.0;

        windVolume *= distVolumeMult;

        this.setSoundGainAndPan(this.wind_sound, windVolume);

        let tempC = KtoC(potentialToRealT(baseTextureValues[3], justAboveSurfaceCellY));

        gl.readBuffer(gl.COLOR_ATTACHMENT1); // watertexture
        var waterTextureValues = new Float32Array(4);
        gl.readPixels(simXpos, justAboveSurfaceCellY, 1, 1, gl.RGBA, gl.FLOAT, waterTextureValues);

        // rain / hail sound: mutually exclusive by construction. Both used to read the exact same grid
        // PRECIPITATION value near the surface with independent gates (temperature for rain, CAPE for
        // hail), so a warm, high-CAPE storm played both sounds together over identical precipitation.
        // This now classifies the sampled point as ONE of the two: hail "owns" it while cold enough and
        // CAPE is high enough to be forming hail (precipitationShader.vert's own spawn gate), and hands
        // off to rain as it melts through the 0-3C band -- the same band the old rain fade already used,
        // and the one hailMeltingRate uses to melt hail back into rain near the surface. Note this reads
        // PRECIPITATION only (not CLOUD) because the sample point is a few cells above the ground --
        // water[CLOUD] is essentially always ~0 that close to the surface (clouds don't reach the
        // ground), so requiring CLOUD+PRECIPITATION to clear the in-cloud spawn threshold here was never
        // actually reachable and would silently mute the sound whenever hail was actually falling.
        const capeExcess = Math.max(guiControls.CAPE - guiControls.hailCapeThreshold, 0);
        const hailFormationActive = guiControls.hailEnabled && capeExcess > 200; // same CAPE qualifying condition as hail spawning
        const hailMeltFraction = clamp(tempC / 3.0, 0.0, 1.0);                   // 0 = still hail-cold, 1 = fully melted to rain
        const isHailHere = hailFormationActive && hailMeltFraction < 1.0;

        // rain sound
        let rainVolume = 0;

        if (tempC > 0 && !isHailHere) {
          rainVolume = Math.pow(waterTextureValues[2] * 0.5, 0.5);

          rainVolume *= map_range_C(tempC, 0., 3., 0., 1.); // rain sound fades as temperature approaches 0 (wet snow)

          rainVolume *= distVolumeMult;
        }

        this.setSoundGainAndPan(this.rain_sound, rainVolume);

        // hail sound: only ever plays while isHailHere is true, so never alongside rain_sound for the
        // same precipitation.
        let hailVolume = 0;
        let hailPan = 0;

        if (isHailHere) {
          const hailPrecipNearGround = waterTextureValues[2]; // PRECIPITATION falling near the camera

          hailVolume = Math.pow(hailPrecipNearGround * 0.5, 0.5) * (1.0 - hailMeltFraction); // fades through the melt band instead of cutting instantly

          hailVolume *= distVolumeMult;

          // The hail swath is now spatially concentrated (see precipitationShader.vert), so unlike rain
          // it is worth locating and panning towards: scan the same visible strip used for the ambience
          // sounds above for where the near-ground precipitation is actually concentrated, and pan there.
          var hailStripValues = new Float32Array(4 * sampleWidth);
          gl.readPixels(simXpos - sampleWidth_2, justAboveSurfaceCellY, sampleWidth, 1, gl.RGBA, gl.FLOAT, hailStripValues);

          let weightedPos = 0;
          let totalWeight = 0;
          for (let i = 0; i < sampleWidth; i++) {
            const w = hailStripValues[i * 4 + 2]; // PRECIPITATION
            weightedPos += (i - sampleWidth_2) * w;
            totalWeight += w;
          }
          if (totalWeight > 0.01)
            hailPan = clamp(weightedPos / (totalWeight * sampleWidth_2), -1, 1);

          // The swath is narrow now, so being right under it vs. just off to the side should matter a
          // lot: sharply cut the volume the further the swath's center sits from the middle of the view.
          hailVolume *= Math.pow(1.0 - Math.abs(hailPan), 3.0);
        }

        const hailUseHeavy = guiControls.CAPE > guiControls.hailCapeThreshold + 1200; // extreme CAPE -> the heavier sample

        this.setSoundGainAndPan(hailUseHeavy ? this.hail_heavy_sound : this.hail_light_sound, hailVolume, hailPan);
        this.setSoundGainAndPan(hailUseHeavy ? this.hail_light_sound : this.hail_heavy_sound, 0);

        if ((hailVolume > 0.001) !== this.hailAudible) { // log only on silence <-> audible transitions
          console.log(hailVolume > 0.001 ? `Lecture du son de grêle : ${hailVolume.toFixed(2)} (${hailUseHeavy ? 'hail_heavy.mp3' : 'hail_light.mp3'})`
                                          : '[hail audio] no hail on screen -> muted');
          this.hailAudible = hailVolume > 0.001;
        }

        //    console.log(distVolumeMult, rainVolume, windVolume, hailVolume);
      }

      // Tornado siren: each station has its own alarm toggle (station.isAlarmEnabled()) and its own alert
      // once STP nearby crosses the threshold (station.getSTP() already samples a radius around the
      // station -- see Weatherstation.measure()); the siren's volume then falls off with real-world
      // distance from whichever alerting station is closest, and goes silent once every alerting station
      // is outside the camera's extended field of view. The camera's own column (guiControls.STP,
      // independent of any station) always counts as being right at the epicenter -- full volume,
      // regardless of camera zoom -- since a warning shouldn't go quiet just because the player zoomed out.
      const tornadoSirenThreshold = 11.0; // alarm-worthy: an extreme, rare STP value
      const viewSTP = guiControls.STP || 0;

      const domainWidth_m = sim_res_x * cellHeight;
      const camXpos_m = ((-Xpos + 1) * 0.5 * sim_res_x) * cellHeight;
      const sirenRange_m = Math.max(camDistFromSim * 2.0, 1); // "extended field of view": audible out to ~2x the visible half-width

      let sirenIntensity = viewSTP > tornadoSirenThreshold ? 1.0 : 0.0;

      for (const station of weatherStations) {
        if (!station.isAlarmEnabled() || station.getSTP() <= tornadoSirenThreshold)
          continue;

        const stationX_m = station.getXpos() * cellHeight;
        let dist_m = Math.abs(camXpos_m - stationX_m);
        if (guiControls.wrapHorizontally)
          dist_m = Math.min(dist_m, domainWidth_m - dist_m);

        const falloff = clamp(1.0 - dist_m / sirenRange_m, 0.0, 1.0);
        sirenIntensity = Math.max(sirenIntensity, falloff);
      }

      this.setTornadoSiren(sirenIntensity);

      if (airplaneMode) {
        let camXnorm = 1. - (cam.curXpos + 1.0) / 2.0;
        let camYnorm = 1. - (cam.curYpos * sim_aspect + 1.0) / 2.0;

        //    console.log(camXnorm, airplane.phys.pos.x);

        const vecCamToPlaneOnFlatSimArea = airplane.phys.pos.copy().subtract(new Vec2D(camXnorm * cellHeight * sim_res_x, camYnorm * cellHeight * sim_res_y));

        const distCamToPlane = new Vec2D(vecCamToPlaneOnFlatSimArea.mag(), camDistFromSim).mag();

        const horizontalAngleCamToPlane = new Vec2D(camDistFromSim, vecCamToPlaneOnFlatSimArea.x).angle() * radToDeg;

        this.jetEngineSound.update(airplane.getN1(), distCamToPlane, horizontalAngleCamToPlane);
      }
    }

    setSoundLeftRight(sound, L, R)
    {
      let gain = Math.max(L, R);
      if (gain == 0) {
        this.setSoundGainAndPan(sound, 0, 0);
        return;
      }
      let pan = (R - L) / gain;
      this.setSoundGainAndPan(sound, gain, pan);
    }

    setSoundGainAndPan(sound, gain, pan = 0.0)
    {
      if (!sound)
        return;

      sound.gain.value = Number.isFinite(gain) ? gain : 0;
      sound.pan.value = Number.isFinite(pan) ? pan : 0;
    }


    mute()
    {
      this.setSoundGainAndPan(this.forest_sound, 0);
      this.setSoundGainAndPan(this.beach_sound, 0);
      this.setSoundGainAndPan(this.urban_sound, 0);
      this.setSoundGainAndPan(this.rain_sound, 0);
      this.setSoundGainAndPan(this.wind_sound, 0);
      this.setSoundGainAndPan(this.hail_light_sound, 0);
      this.setSoundGainAndPan(this.hail_heavy_sound, 0);
      this.hailAudible = false;
      if (this.tornado_siren_sound)
        this.tornado_siren_sound.gain.cancelScheduledValues(this.audioCtx.currentTime); // drop any in-progress fade before snapping to silent
      this.setSoundGainAndPan(this.tornado_siren_sound, 0);
      this.sirenAudible = false;
      this.jetEngineSound.mute();
    }

    // intensity: 0..1, how loud the alarm should be right now -- combines each station's own STP-threshold
    // crossing and alarm toggle with distance falloff from the camera, or 1.0 if the camera's own column
    // is itself above threshold (see updateAmbientSound). guiControls.sirenMuted is a separate master
    // override that silences the alarm regardless of intensity, on top of every station's own toggle.
    setTornadoSiren(intensity)
    {
      const targetIntensity = guiControls.sirenMuted ? 0 : clamp(intensity, 0, 1);
      const isActiveNow = targetIntensity > 0.001;

      if (this.tornado_siren_sound) {
        const targetGain = targetIntensity * 0.8;
        // Continuous fade instead of snapping the gain instantly -- this also smooths out continuous
        // distance changes as the camera pans, not just on/off transitions. Especially important going
        // quiet: the siren winds down over ~1.5s (STP dropping below threshold, or the storm moving out
        // of range) rather than cutting off mid-wail. A single reused AudioParam ramp, no new sound objects.
        if (Math.abs(targetGain - this.tornado_siren_sound.gain.value) > 0.002 || isActiveNow !== this.sirenAudible) {
          const now = this.audioCtx.currentTime;
          const fadeSeconds = targetGain < this.tornado_siren_sound.gain.value ? 1.5 : 1.0;
          this.tornado_siren_sound.gain.cancelScheduledValues(now);
          this.tornado_siren_sound.gain.setValueAtTime(this.tornado_siren_sound.gain.value, now);
          this.tornado_siren_sound.gain.linearRampToValueAtTime(targetGain, now + fadeSeconds);
        }
      }

      if (isActiveNow !== this.sirenAudible) { // log only on silence <-> audible transitions
        console.log(isActiveNow ? 'ALERTE : sirène de tornade déclenchée (STP élevé détecté)' : '[siren audio] sirène coupée (fondu)');
        this.sirenAudible = isActiveNow;
      }
    }
  }

  // AIRPLANE

  class PIDController
  {
    #previousValue;
    #previousError;
    integral;

    constructor(kp, ki, kd, iThreshold)
    {
      this.kp = kp; // Proportional gain
      this.ki = ki; // Integral gain
      this.kd = kd; // Derivative gain
      this.iThreshold = iThreshold;
      this.resetState();
    }

    resetState()
    {
      this.#previousValue = 0;
      this.#previousError = 0;
      this.integral = 0;
    }

    update(setpoint, measuredValue)
    {
      const error = setpoint - measuredValue;

      const derivative = error - this.#previousError;

      let integralActive =
        this.iThreshold == null || (Math.abs(error) < this.iThreshold && Math.abs(derivative) < this.iThreshold / 100.); // only adjust integral if already close and stable to target

      if (integralActive)
        this.integral += error;
      else
        this.integral = 0;

      this.#previousError = error;
      this.#previousValue = measuredValue;

      let totalOutput = this.kp * error + this.kd * derivative;

      if (integralActive) {
        totalOutput += this.ki * this.integral;
      }

      return totalOutput;
    }
  }

  class Autopilot
  {
    mode;
    autoThrottleEnabled;
    targetPitch;
    targetAltitude;
    targetIAS;
    targetGlideslope;

    // dependencies:
    #instrumentPanel;
    #airplane;

    constructor(airplane)
    {
      this.#airplane = airplane;
      // PID for altitude to pitch
      this.altitudePID = new PIDController(0.04, 0.00003, 20.0, 100.0);
      // PID for pitch to elevator
      this.pitchPID = new PIDController(0.4, 0.001, 20.0, 5.0, true); // 0.5, 0.001, 100.0

      this.speedPID = new PIDController(0.05, 0.00005, 1.0, 10.0);

      // PID for glideslope to pitch
      this.glideslopePID = new PIDController(2.0, 0.0015, 5.0, 3.0);

      this.targetPitch = 0.0;
      this.targetAltitude = 5000.0;
      this.targetIAS = 0.0;
      this.mode = 'ALTITUDE';

      this.autoThrottleEnabled = false;

      this.targetGlideslope = -3.0;
    }

    bindInstrumentPanel(instrumentPanel) { this.#instrumentPanel = instrumentPanel; }

    setMode(mode) { this.mode = mode; }

    setAutoThrottle(ATHR_state) { this.autoThrottleEnabled = ATHR_state; }

    resetState()
    {
      this.altitudePID.resetState();
      this.pitchPID.resetState();
      this.speedPID.resetState();
      this.glideslopePID.resetState();
    }

    update(pitchAttitude, altitude, trueVel, IAS, vecToRunway, gearOnGround)
    {
      let targetIAS = this.targetIAS;

      switch (this.mode) {

      case 'ALTITUDE':
        this.targetPitch = clamp(this.altitudePID.update(this.targetAltitude, altitude) + 3.0, -6.0, 10.0); // add 3.0 degree pitch bias

        this.targetPitch *= 1.0 - Math.abs(trueVel.y) * 0.03;                                               // limit vertical speed

        break;
      case 'AUTOLAND':

        if (vecToRunway.x <= 4000) {
          this.#airplane.setGear(true);
        }

        let currentGlideslope = trueVel.angle() * radToDeg;
        let adjustedTargetGlideslope = 0.0;

        if (vecToRunway.x <= 200) {
          adjustedTargetGlideslope = Math.max((vecToRunway.y - 10) * -0.08, -2.0); // flare
          // targetGlideslope = Math.max(targetGlideslope, currentGlideslope); // prevent acelerating down when entering at shallow angle
          targetIAS = 0.0;

        } else {

          let slopeToRunway = vecToRunway.angle() * radToDeg;

          adjustedTargetGlideslope = this.targetGlideslope + clamp((slopeToRunway - this.targetGlideslope) * 3.0, -5.0, 3.0); // move towards ideal glideslope

          targetIAS = map_range_C(vecToRunway.x, 2000, 15000, 95, 128);                                                       // target speed depend on distance to runway
          this.#instrumentPanel.setTargetIAS(msToKnots(targetIAS));
        }

        this.targetPitch = clamp(this.glideslopePID.update(adjustedTargetGlideslope, currentGlideslope) + 0.0, -6.0, 10.0);

        break;
      }


      let throttle = clamp(this.speedPID.update(targetIAS, IAS) + 0.60, 0.0, 1.0); // add 60% thrust bias

      // console.log(this.targetAltitude, altitude, this.targetPitch);

      let elevator = clamp(this.pitchPID.update(this.targetPitch, pitchAttitude) + 0.2, -1.0, 1.0);


      if (gearOnGround) {
        elevator = 0.40;
        throttle = -1.0;
      }

      //  console.log(this.#desiredPitch, pitchAttitude, elevator);

      return [ elevator, throttle ];
    }
  }

  class N1Indicator
  {
    container;
    percentText;
    fillArc;
    arcLength;

    constructor(parentElement)
    {
      this.container = document.createElement('div');
      this.container.innerHTML += `
          <svg class="gauge" viewBox="0 90 320 90" aria-hidden="true">
            <path class="bg-arc" d="M40 140 A120 120 0 0 1 280 140" />
            <path id="fillArc" class="fill-arc" d="M40 140 A120 120 0 0 1 280 140" />
            <text id="percentText" x="160" y="140" class="value">0%</text>
          </svg>
      `;

      this.percentText = this.container.querySelector('#percentText');
      this.fillArc = this.container.querySelector('#fillArc');

      this.arcLength = this.fillArc.getTotalLength();
      this.fillArc.style.strokeDasharray = this.arcLength + ' ' + this.arcLength;
      this.fillArc.style.strokeDashoffset = this.arcLength;

      parentElement.appendChild(this.container);
    }

    getColor(p)
    {
      if (p < 80) {
        const ratio = p / 80;
        const r = Math.round(0 + ratio * 255);
        const g = 255;
        return `rgb(${r},${g},0)`;
      } else if (p < 100) {
        const ratio = (p - 90) / 10;
        const r = 255;
        const g = Math.round(255 - ratio * 155);
        return `rgb(${r},${g},0)`;
      } else {
        return `rgb(255,0,0)`;
      }
    }

    update(N1)
    {
      const p = N1 * 100.;
      this.percentText.textContent = p.toFixed(1) + '%';
      this.fillArc.style.stroke = this.getColor(p);
      const offset = this.arcLength * (1 - p / 100);
      this.fillArc.style.strokeDashoffset = offset;
    }
  }

  class InstrumentPanel
  {
    #instrumentCanvas;
    #panelImg;
    #targetAltInput;
    #targetIASInput;
    #targetGlideslopeInput;
    #autolandButton;
    #autoThrottleButton;
    #altHoldButton;
    #panelDiv;
    #N1Indicator;

    // dependencies:
    #autopilot

    constructor(autopilot)
    {
      this.#autopilot = autopilot;
      this.#panelDiv = document.createElement('div');
      this.#instrumentCanvas = document.createElement('canvas');
      this.#instrumentCanvas.width = 800;
      this.#instrumentCanvas.height = 660;
      this.#panelDiv.style.opacity = 0.7;
      this.#panelDiv.style.position = 'absolute';
      this.#panelDiv.style.bottom = 0;
      this.#panelDiv.style.right = 0;
      this.#panelDiv.style.left = 'auto';
      this.loadImages();
      this.genAutopilotBar(this.#panelDiv);
      this.#panelDiv.appendChild(this.#instrumentCanvas);
      body.appendChild(this.#panelDiv);
    }

    setDisplaySideRight(right)
    {
      if (right) {
        this.#panelDiv.style.right = 0;
        this.#panelDiv.style.left = 'auto';
      } else { // left
        this.#panelDiv.style.right = 'auto';
        this.#panelDiv.style.left = 0;
      }
    }

    setMode_AUTOLAND(on)
    {
      if (on) {
        this.#autopilot.setMode('AUTOLAND');
        this.#altHoldButton.checked = false;
      } else {
        this.#autopilot.setMode('NONE');
      }
    }

    setMode_ALTITUDE(on)
    {
      if (on) {
        this.#autopilot.setMode('ALTITUDE');
        this.#autolandButton.checked = false;
      } else {
        this.#autopilot.setMode('NONE');
      }
    }

    setAutoThrottle(ATHR_state) { this.#autopilot.setAutoThrottle(ATHR_state); }

    genAutopilotBar(panelDiv)
    {
      const container = document.createElement('div');

      const speedLabel = document.createElement('label');
      speedLabel.style = 'position: absolute; left: 10px;';

      this.#targetIASInput = document.createElement('input');
      this.#targetIASInput.type = 'number';
      this.#targetIASInput.id = 'speed';
      this.#targetIASInput.className = 'autopilotNumberInput';
      this.#targetIASInput.min = '0';
      this.#targetIASInput.max = '330';
      this.#targetIASInput.step = '5';
      this.#targetIASInput.value = '220';
      this.#targetIASInput.style = 'width: 150px;';
      this.#targetIASInput.addEventListener('wheel', (e) => { e.stopPropagation(); });
      this.#targetIASInput.addEventListener('keydown', (e) => { e.stopPropagation(); });
      speedLabel.appendChild(this.#targetIASInput);

      const speedSpan = document.createElement('span');
      speedSpan.textContent = 'KT';
      speedSpan.style = 'position: absolute; right: 100px;';
      speedLabel.appendChild(speedSpan);
      container.appendChild(speedLabel);

      this.#autoThrottleButton = document.createElement('input');
      this.#autoThrottleButton.type = 'checkbox';
      this.#autoThrottleButton.id = 'athr';
      this.#autoThrottleButton.className = 'airbus-switch';
      this.#autoThrottleButton.addEventListener('change', () => this.setAutoThrottle(this.#autoThrottleButton.checked));
      container.appendChild(this.#autoThrottleButton);

      let athrLabel = document.createElement('label');
      athrLabel.htmlFor = 'athr';
      athrLabel.className = 'airbus-label';
      athrLabel.innerHTML = 'A/THR';
      athrLabel.style = 'position: absolute; left: 200px;';
      container.appendChild(athrLabel);

      this.#N1Indicator = new N1Indicator(container);

      const glideSlopeLabel = document.createElement('label');
      glideSlopeLabel.style = 'position: absolute; left: 420px;';

      this.#targetGlideslopeInput = document.createElement('input');
      this.#targetGlideslopeInput.type = 'number';
      this.#targetGlideslopeInput.id = 'targetGlideSlopeInput';
      this.#targetGlideslopeInput.className = 'autopilotNumberInput';
      this.#targetGlideslopeInput.name = 'altitude';
      this.#targetGlideslopeInput.min = '2';
      this.#targetGlideslopeInput.max = '6';
      this.#targetGlideslopeInput.step = '1';
      this.#targetGlideslopeInput.value = '3';
      this.#targetGlideslopeInput.style.width = '55px';
      this.#targetGlideslopeInput.addEventListener('wheel', (e) => { e.stopPropagation(); });
      this.#targetGlideslopeInput.addEventListener('keydown', (e) => { e.stopPropagation(); });
      glideSlopeLabel.appendChild(this.#targetGlideslopeInput);

      const glidSlopeSpan = document.createElement('span');
      glidSlopeSpan.textContent = '°';
      glidSlopeSpan.style = 'position: absolute; right: 20px;';
      glideSlopeLabel.appendChild(glidSlopeSpan);
      container.appendChild(glideSlopeLabel);

      this.#autolandButton = document.createElement('input');
      this.#autolandButton.type = 'checkbox';
      this.#autolandButton.id = 'autoland';
      this.#autolandButton.className = 'airbus-switch';
      this.#autolandButton.addEventListener('change', e => {this.setMode_AUTOLAND(e.target.checked)});
      container.appendChild(this.#autolandButton);

      let autolandLabel = document.createElement('label');
      autolandLabel.htmlFor = 'autoland';
      autolandLabel.className = 'airbus-label';
      autolandLabel.innerHTML = 'LAND';
      autolandLabel.style = 'position: absolute; left: 500px;';
      container.appendChild(autolandLabel);

      this.#altHoldButton = document.createElement('input');
      this.#altHoldButton.type = 'checkbox';
      this.#altHoldButton.id = 'althold';
      this.#altHoldButton.className = 'airbus-switch';
      this.#altHoldButton.addEventListener('change', e => {this.setMode_ALTITUDE(e.target.checked)});
      container.appendChild(this.#altHoldButton);

      let altLabel = document.createElement('label');
      altLabel.htmlFor = 'althold';
      altLabel.className = 'airbus-label';
      altLabel.innerHTML = 'ALT';
      altLabel.style = 'position: absolute; left: 600px;';
      container.appendChild(altLabel);


      const targetAltitudeLabel = document.createElement('label');

      this.#targetAltInput = document.createElement('input');
      this.#targetAltInput.type = 'number';
      this.#targetAltInput.id = 'altitude';
      this.#targetAltInput.className = 'autopilotNumberInput';
      this.#targetAltInput.name = 'altitude';
      this.#targetAltInput.min = '0';
      this.#targetAltInput.max = '40000';
      this.#targetAltInput.step = '100';
      this.#targetAltInput.value = '10000';
      this.#targetAltInput.style.width = '55px';
      this.#targetAltInput.style = 'position: absolute; left: 670px;';
      this.#targetAltInput.addEventListener('wheel', (e) => { e.stopPropagation(); });
      this.#targetAltInput.addEventListener('keydown', (e) => { e.stopPropagation(); });
      targetAltitudeLabel.appendChild(this.#targetAltInput);

      const targetAltSpan = document.createElement('span');
      targetAltSpan.textContent = 'ft';
      targetAltSpan.style = 'position: absolute; right: 70px;';
      targetAltitudeLabel.appendChild(targetAltSpan);

      container.appendChild(targetAltitudeLabel);


      container.style = 'height: 60px; display: flex; justify-content: space-between; align-items: center; background-color: #222222; color: white';

      panelDiv.appendChild(container);

      this.setMode_ALTITUDE();
    }

    setTargetIAS(targetIAS) { this.#targetIASInput.value = targetIAS.toFixed(0); }


    getTargetAlt() { return this.#targetAltInput.value / mToFt; }
    getTargetIAS() { return knotsToMs(this.#targetIASInput.value); }
    getTargetGlideslope() { return -this.#targetGlideslopeInput.value; }

    remove()
    {
      this.#instrumentCanvas.remove();
      this.#panelDiv.remove()
    }

    async loadImages() { this.#panelImg = await loadImage('resources/img/Panel.png'); }

    async display(pitchAngle, airAngle, altitude, radarAltitude, IAS, trueVel, OAT_C, throttle, N1, elevator, targetPitch, autopilotEn, gearStatus, runwayPointer, vecToRunway, brake)
    {
      let ctx = this.#instrumentCanvas.getContext('2d');
      let width = this.#instrumentCanvas.width - 50;
      let height = this.#instrumentCanvas.height;
      const topBarHeight = 50;
      let mainHeight = height - topBarHeight; // height of virtual horizon part

      let targetAltitude = this.getTargetAlt();
      let targetIAS = this.getTargetIAS();

      // ATTITUDE INDICATOR / VIRTUAL HORIZON:

      const pixPerDeg = 15.0;

      let y0 = mainHeight / 2 + topBarHeight + pitchAngle * pixPerDeg; // y pos of 0 deg pitch line

      ctx.beginPath();
      ctx.rect(0, -1000, width, 1000 + y0);
      ctx.fillStyle = '#05A3ED'; // blue
      ctx.fill();
      ctx.beginPath();
      ctx.rect(0, y0, width, 1500);
      ctx.fillStyle = '#F0843C'; // brown
      ctx.fill();


      ctx.strokeStyle = 'white';
      ctx.fillStyle = 'white';
      ctx.beginPath();
      for (let i = Math.round((pitchAngle) / 10) * 10 - 50; i < pitchAngle + 50; i += 2.5) {
        let y = y0 - i * pixPerDeg;
        if (i % 10 == 0) {
          ctx.moveTo(width / 2 - width * 0.15, y);
          ctx.lineTo(width / 2 + width * 0.15, y);
          if (i != 0) {
            ctx.fillText(i, width / 2 - width * 0.25, y + 12);
            ctx.fillText(i, width / 2 + width * 0.21, y + 12);
          }
        } else if (i % 5 == 0) {
          ctx.moveTo(width / 2 - width * 0.075, y);
          ctx.lineTo(width / 2 + width * 0.075, y);
        } else { // 2.5 deg
          ctx.moveTo(width / 2 - width * 0.0375, y);
          ctx.lineTo(width / 2 + width * 0.0375, y);
        }
      }
      ctx.stroke();
      ctx.strokeStyle = 'yellow';
      ctx.beginPath();
      let moveIndY = mainHeight / 2 + topBarHeight + (pitchAngle - trueVel.angle() * radToDeg) * pixPerDeg; // airAngle
      ctx.moveTo(width / 2 - width * 0.15, moveIndY);
      ctx.lineTo(width / 2 + width * 0.15, moveIndY);
      ctx.stroke();

      ctx.strokeStyle = 'green';
      ctx.beginPath();
      let targIndY = mainHeight / 2 + topBarHeight + (pitchAngle - targetPitch) * pixPerDeg;
      ctx.moveTo(width / 2 - width * 0.15, targIndY);
      ctx.lineTo(width / 2 + width * 0.15, targIndY);
      ctx.stroke();

      if (vecToRunway.x < 150000) {
        ctx.strokeStyle = 'blue';
        ctx.beginPath();
        let runwayIndY = mainHeight / 2 + topBarHeight + (pitchAngle - runwayPointer) * pixPerDeg;
        ctx.moveTo(width / 2 - width * 0.15, runwayIndY);
        ctx.lineTo(width / 2 + width * 0.15, runwayIndY);
        ctx.stroke();
        ctx.fillStyle = 'blue';
        ctx.font = '20px serif';
        ctx.fillText(printDistance(vecToRunway.x), width / 2 - width * 0.15 - 70, runwayIndY - 5);
        ctx.fillText(printDistance(vecToRunway.y + 7.5), width / 2 + width * 0.15, runwayIndY - 5);
        ctx.fillText((vecToRunway.angle() * radToDeg).toFixed(1) + ' °', width / 2 + width * 0.23, runwayIndY - 5);
      }

      if (this.#panelImg)
        ctx.drawImage(this.#panelImg, 0, topBarHeight, width, mainHeight);

      // ALTITUDE INDICATOR:

      const altIndXpos = 640; // pos of vertical line

      ctx.beginPath();
      ctx.moveTo(altIndXpos, topBarHeight);
      ctx.lineTo(altIndXpos, height);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'white';
      ctx.fillStyle = 'white';
      ctx.stroke();
      ctx.font = '30px serif';

      let unit = ' m'

      if (guiControls.lengthUnit == 'LENGTH_UNIT_IMPERIAL')
      {
        altitude *= mToFt;
        radarAltitude *= mToFt;
        targetAltitude *= mToFt;
        unit = ' ft'
      }

      const pxPerAlt = 0.65;
      const altRange = 500; // + and -

      ctx.beginPath();
      for (let i = Math.round((altitude - altRange) / 100) * 100; i < altitude + altRange; i += 50) {
        let y = mainHeight / 2 + topBarHeight - (i - altitude) * pxPerAlt;
        if (i % 100 == 0) {
          ctx.moveTo(altIndXpos, y);
          ctx.lineTo(altIndXpos + 20, y);
          ctx.fillText(i, altIndXpos + 25, y + 12);
        } else {
          ctx.moveTo(altIndXpos, y);
          ctx.lineTo(altIndXpos + 10, y);
        }
      }
      ctx.stroke();
      ctx.fillStyle = 'black';
      ctx.fillRect(altIndXpos - 3, mainHeight / 2 + topBarHeight - 25, 113, 50);
      ctx.fillStyle = 'white';
      ctx.fillText(altitude.toFixed(0) + unit, altIndXpos, mainHeight / 2 + topBarHeight + 10);

      // Show ground level
      ctx.beginPath();
      ctx.fillStyle = '#aa0000aa';
      ctx.fillRect(altIndXpos - 3, mainHeight / 2 + topBarHeight + radarAltitude * pxPerAlt, 100, 500);

      // Show target altitude
      ctx.beginPath();
      let targetAltY = mainHeight / 2 + topBarHeight + (altitude - targetAltitude) * pxPerAlt;
      ctx.moveTo(altIndXpos, targetAltY);
      ctx.lineTo(altIndXpos + 100, targetAltY);
      ctx.strokeStyle = 'green';
      ctx.stroke();

      // VELOCITY INDICATOR:
      const velIndXpos = 110;
      ctx.beginPath();
      ctx.moveTo(velIndXpos, topBarHeight);
      ctx.lineTo(velIndXpos, height);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'white';
      ctx.fillStyle = 'white';
      ctx.stroke();
      ctx.font = '30px serif';

      let stallSpeed = 70.0; // m/s
      let overSpeed = 173.0; // m/s

      if (guiControls.speedUnit == 'SPEED_UNIT_KT') {
        IAS = msToKnots(IAS);
        targetIAS = msToKnots(targetIAS);
        stallSpeed = msToKnots(stallSpeed);
        overSpeed = msToKnots(overSpeed);
        unit = ' kt'
      } else {
        unit = ' km/h'
        IAS *= 3.6; // convert m/s to km/h
        targetIAS *= 3.6;
        stallSpeed *= 3.6;
        overSpeed *= 3.6;
      }

      const pxPerVel = 10.0;
      const velRange = 35; // + and -

      ctx.beginPath();
      for (let i = Math.max(Math.round((IAS) / 10) * 10 - velRange, 0); i < IAS + velRange; i += 5) {
        let y = mainHeight / 2 + topBarHeight - (i - IAS) * pxPerVel;
        if (i % 10 == 0) {
          ctx.moveTo(velIndXpos - 20, y);
          ctx.lineTo(velIndXpos, y);
          ctx.fillText(i, 0, y + 12);
        } else {
          ctx.moveTo(velIndXpos - 10, y);
          ctx.lineTo(velIndXpos, y);
        }
      }
      ctx.stroke();
      ctx.fillStyle = 'black';
      ctx.fillRect(0, mainHeight / 2 + topBarHeight - 25, velIndXpos + 3, 50);
      ctx.fillStyle = 'white';
      ctx.fillText(IAS.toFixed(0) + unit, 0, mainHeight / 2 + topBarHeight + 10);

      // Show stall speed
      ctx.beginPath();
      ctx.fillStyle = '#aa0000aa';
      ctx.fillRect(0, mainHeight / 2 + topBarHeight + (IAS - stallSpeed) * pxPerVel, velIndXpos + 3, 5000);

      // Show over speed
      ctx.beginPath();
      ctx.fillStyle = '#aa0000aa';
      ctx.fillRect(0, mainHeight / 2 + topBarHeight + (IAS - overSpeed) * pxPerVel - 5000, velIndXpos + 3, 5000);

      // Show target IAS
      ctx.beginPath();
      let targetIasY = mainHeight / 2 + topBarHeight + (IAS - targetIAS) * pxPerVel;
      ctx.moveTo(0, targetIasY);
      ctx.lineTo(velIndXpos + 3, targetIasY);
      ctx.strokeStyle = 'green';
      ctx.stroke();

      // VERTICAL VElOCITY INDICATOR
      ctx.fillStyle = 'black';
      ctx.fillRect(width, topBarHeight, 50, mainHeight);
      let hue = clamp(120.0 + trueVel.y * 10.0, 0.0, 200.0);
      ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;

      let verticalSpeedIndicatorVal = trueVel.y < 0 ? Math.sqrt(-trueVel.y) : -Math.sqrt(trueVel.y);
      ctx.fillRect(width + 10, mainHeight / 2 + topBarHeight, 30, verticalSpeedIndicatorVal * 40.);

      ctx.fillStyle = 'black';
      ctx.fillRect(width, mainHeight / 2 + topBarHeight - 13, 50, 26);

      const [veloStr, unitStr] = printVerticalVelocity(trueVel.y);

      ctx.font = '20px serif';
      ctx.fillStyle = 'white';
      ctx.fillText(veloStr, width, mainHeight / 2 + topBarHeight + 6);
      ctx.fillText(unitStr, width + 10, mainHeight / 2 + topBarHeight + 22);

      // OVERHEAD
      ctx.fillStyle = '#222222';
      ctx.fillRect(0, 0, this.#instrumentCanvas.width, topBarHeight);

      ctx.fillStyle = '#00FFFF';
      ctx.font = '30px serif';
      ctx.fillText('🌡 ' + printTemp(OAT_C), 0, 40);

      ctx.fillStyle = '#FFFF00';
      ctx.fillText('🎚️ ' + throttle.toFixed() + ' %', 140, 40);

      this.#N1Indicator.update(N1);

      let gearStatusIndicator = '';
      if (gearStatus == 'UP') {
        gearStatusIndicator = 'UP';
        ctx.fillStyle = '#444444';
      } else if (gearStatus == 'EXTENDING' || gearStatus == 'RETRACTING') {
        gearStatusIndicator = 'UNLK';
        ctx.fillStyle = '#FF0000';
      } else if (gearStatus == 'DOWN') {
        gearStatusIndicator = '▽▽▽';
        ctx.fillStyle = '#00FF00';
      }
      ctx.fillText(gearStatusIndicator, 290, 40);


      let AOA = pitchAngle - airAngle;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('∠ ' + AOA.toFixed(1) + '°', 410, 40);

      if (AOA > 14.0) {
        ctx.fillStyle = '#FF0000';
        ctx.fillText('STALL!', 605, 40);
      }

      if (autopilotEn) {
        ctx.fillStyle = '#00FF00';
        ctx.fillText('AP', 540, 40);
      }

      if (IAS > overSpeed) {
        ctx.fillStyle = '#FF0000';
        ctx.fillText('Overspeed!', 605, 40);
      }

      // BELOW VIRTUAL HORIZON

      ctx.fillStyle = '#AAA';
      ctx.fillText('GS: ' + printVelocity(trueVel.mag()), 130, 640);

      if (brake) {
        ctx.fillStyle = '#F00';
        ctx.fillText('BRAKE', 340, 640);
      }

      ctx.fillStyle = '#AAA';
      ctx.fillText('ELE: ' + elevator.toFixed(2), 500, 640);
    }
  }


  const dt = 1. / FPS;

  class PhysicsObject
  {        // 2D PhysicsObject
    m;     // mass in kg
    I;     // moment of inertia
    pos;   // in meters
    vel;   // in m/s
    angle; // radians
    aVel;  // angular velocity in rad/s

    constructor(m, I, x, y, vx, vy)
    {
      this.m = m;
      this.I = I;
      this.pos = new Vec2D(x, y);
      this.vel = new Vec2D(vx, vy);
      this.angle = 0.0;
      this.aVel = 0.0;
    }

    applyAcceleration(a) { this.vel.add(a.mult(dt)); }

    applyForce(F, pos) // position relative to center
    {
      F.mult(dt);
      this.vel.add(F.copy().div(this.m)); // simply apply force at center of mass
      if (pos != null) {                  // apply torque if force not applied at the center of mass

        let angleToCm = pos.angle();      // angle to center of mass

                                          // console.log(F);
        F.rotate(-angleToCm); // make force vector perpendicular to vector to center off mass

                              // console.log('After rotating ', F, angleToCm * radToDeg);

        let torque = -F.y * pos.mag(); // if force perpendicular to vector from center, mult by dist from center
        this.aVel += torque / this.I;
      }
    }

    move(directionIsLeft)
    {
      let movementPerFrame = this.vel.copy();
      movementPerFrame.mult(dt);
      if (!directionIsLeft)
        movementPerFrame.x = -movementPerFrame.x;
      this.pos.add(movementPerFrame);
      this.pos.x = mod(this.pos.x, sim_res_x * cellHeight); // make sure airplane position stays within sim area
      this.angle += this.aVel * dt;                         // rotate
    }
  }

  class JetEngine
  {
    N1;     // 0. to 1.
    thrust; // 0. to 1.
    starting;
    started;

    constructor()
    {
      this.N1 = 0.186;
      this.starting = false;
      this.started = true;
    }

    toggle()
    {
      if (this.started) {
        this.stop();
      } else {
        this.start();
      }
    }

    start()
    {
      if (!this.started) {
        this.starting = true;
      }
    }

    stop()
    {
      this.started = false;
      this.starting = false;
    }

    update(throttle)
    {
      if (this.starting) {
        this.N1 += 0.00008;
        this.N1 *= 1.006;
        if (this.N1 >= 0.15) {
          this.starting = false;
          this.started = true;
        }
      } else if (this.started)
        this.N1 += (Math.abs(throttle) + 0.223) * 0.0042;

      this.N1 *= 0.995; // drag

      this.thrust = Math.pow(this.N1, 2.0);

      return throttle < 0. ? this.thrust * -0.7 : this.thrust;
    }
  }

  class Airplane
  {
    #instrumentPanel;
    #autopilot;

    directionIsLeft; // false means right

    #relVelAngle;    // angle of velocity relative to air
    #airspeed;       // true airspeed, m/s
    #groundSpeed;
    #IAS;            // indicated airspeed, m/s
    #camFollow;
    #OAT;            // outdoor air temperature

    #radarAltitude;  // meters above ground
    #framesSinceCrash;
    #gearExtPos;     // down: 0.0  up: 7.0
    #gearOnGround;   // if the wheels are touching the ground
    #braking;

    #runwayThresholdPos;

    // Controls
    elevator;
    throttle;
    prevThrottle;

    #gearStatus; // UP EXTENDING DOWN RETRACTING
    #autopilotEnabled;

    jetEngine;

    phys; // physics object, containing all physical properties including position and velocity

    getClosestRunwayPos()
    {
      let Xpos = Math.floor(mod(this.phys.pos.x / cellHeight, sim_res_x));
      // let Ypos = Math.floor(clamp(this.phys.pos.y / cellHeight + 1.0, 100, sim_res_y - 1));

      let Ypos = 90;

      // console.log(Ypos);

      gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
      gl.readBuffer(gl.COLOR_ATTACHMENT2); // walltexture
      var wallTextureValues = new Int8Array(sim_res_x * 4);
      gl.readPixels(0, Ypos, sim_res_x, 1, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues);

      if (this.directionIsLeft) {
        let x = Xpos - 1;
        while (x != Xpos) {
          if (x < 0)
            x = sim_res_x - 1;

          if (wallTextureValues[x * 4 + 0] == 5) // found runway
          {
            return new Vec2D(x * cellHeight, (Ypos - wallTextureValues[x * 4 + 2]) * cellHeight + 15);
          }
          x--;
        }
      } else { // direction is right
        let x = Xpos + 1;
        while (x != Xpos) {
          if (x > sim_res_x - 1)
            x = 0;

          if (wallTextureValues[x * 4 + 0] == 5) // found runway
          {
            return new Vec2D(x * cellHeight, (Ypos - wallTextureValues[x * 4 + 2]) * cellHeight + 15);
          }
          x++;
        }
      }
      return new Vec2D(0, 0);
    }

    constructor()
    {
      this.#camFollow = true;
      this.phys = new PhysicsObject(1, 1, 0, 0);
      this.phys.pos.x = -99.0;
      this.phys.pos.y = -99.0;
      this.#IAS = 0.0;
      this.#OAT = 0.0;
      this.#airspeed = 0.0;
      this.#groundSpeed = 0.0;
      this.#autopilotEnabled = false;
      this.#gearOnGround = false;
      this.#braking = false;
      this.#runwayThresholdPos = new Vec2D(0, 0);
    }

    toggleCamFollow()
    {
      if (airplaneMode)
        this.#camFollow = !this.#camFollow;
    }

    enableAirplaneMode(autopilotEn)
    {
      this.#autopilot = new Autopilot(this);
      this.setAutopilot(autopilotEn);
      this.#instrumentPanel = new InstrumentPanel(this.#autopilot);
      this.#autopilot.bindInstrumentPanel(this.#instrumentPanel);
      airplaneMode = true;
      this.directionIsLeft = true; // left
      this.#camFollow = true;
      let M = 400 * 1000;          // mass: 400 tons
      let L = 50.0;                // effective length in meters
      let I = 1 / 12 * M * L * L;  // moment of inertia

      let simXpos = Math.floor(mouseXinSim * sim_res_x);
      let simYpos = findSimYposAboveSurfaceAtMouseX();

      let startsOnSurface = simYpos > (mouseYinSim * sim_res_y); // It is placed above the mouse position

      let planePosX = simXpos * cellHeight;
      let planePosY = Math.min(simYpos * cellHeight - (startsOnSurface ? 32.0 : 0.0), 15000.0);

      let velX = startsOnSurface ? 0.0 : map_range_C(mouseYinSim, 0.0, 1.0, -100.0, -200);

      this.phys = new PhysicsObject(M, I, planePosX, planePosY, velX, 0.0);
      this.phys.angle = startsOnSurface ? 0.0 : 5.0 * degToRad;
      this.throttle = startsOnSurface ? 0.00 : 0.40; // %

      if (startsOnSurface) {
        this.#gearStatus = 'DOWN';
        this.#gearExtPos = 0.0;
      } else {
        this.#gearStatus = 'UP';
        this.#gearExtPos = 7.0;

        this.#runwayThresholdPos = this.getClosestRunwayPos();
      }

      cam.tarZoom = 100.0;

      this.jetEngine = new JetEngine();
      soundSystem.jetEngineSound.start();
    }

    changeDirection()
    {
      if (this.directionIsLeft) {
        if (!confirm('Do you want to change the flight direction to Right?'))
          return;
      } else {
        if (!confirm('Do you want to change the flight direction to Left?'))
          return;
      }
      this.directionIsLeft = !this.directionIsLeft;
      this.#instrumentPanel.setDisplaySideRight(this.directionIsLeft);
      this.#runwayThresholdPos = this.getClosestRunwayPos();
    }

    disableAirplaneMode()
    {
      airplaneMode = false;
      this.#framesSinceCrash = -1;
      this.phys.pos.x = -99.0;
      this.phys.pos.y = -99.0;
      this.#camFollow = false;
      this.display(); // run display function one more time to update uniforms
      this.#instrumentPanel.remove();
      document.body.style.cursor = 'default';
      soundSystem.jetEngineSound.stop();
    }

    getN1() { return this.jetEngine ? this.jetEngine.N1 : 0.0; }

    onUpPressed()
    {
      if (this.throttle == 0.) {
        this.throttle = +0.01;
      }
    }

    onDownPressed()
    {
      if (this.throttle == 0.) {
        this.throttle = -0.01;
      }
    }

    setBrakes(enabled) { this.#braking = enabled; }

    toggleEngine() { this.jetEngine.toggle(); }

    toggleGear() { this.setGear(this.#gearStatus == 'UP'); }

    setGear(boolDown)
    {
      if (boolDown) {
        if (this.#gearStatus == 'UP')
          this.#gearStatus = 'EXTENDING';

      } else {
        if (this.#gearStatus == 'DOWN')
          this.#gearStatus = 'RETRACTING';
      }
    }

    // https://aviation.stackexchange.com/questions/64490/is-there-a-simple-relationship-between-angle-of-attack-and-lift-coefficient/97747#97747?newreg=547ea95b1d784abf993b7d1850dcc938
    Cl(AOA) // lift coefficient https://www.desmos.com/calculator/aeeizqvarp
    {
      let lift = 0.0;
      if ((AOA > 0. && AOA < PI / 7.23) || (AOA > 7. / 8.124 * PI && AOA < PI)) {
        lift = Math.sin(6. * AOA);
      } else {
        lift = Math.sin(2. * AOA);
      }
      return lift;
    }

    Cd(AOA) // drag coefficient
    {
      return 1.0 - Math.cos(2 * AOA);
    }

    move()
    {
      if (this.#framesSinceCrash >= 0) {
        this.#framesSinceCrash++;
        if (this.#framesSinceCrash > 30)
          this.disableAirplaneMode();
        return;
      }

      let Xpos = mod(this.phys.pos.x / cellHeight - 1., sim_res_x);
      let Ypos = Math.min(this.phys.pos.y / cellHeight + 1.0, sim_res_y - 1);

      let fractX = fract(Xpos);
      let fractY = fract(Ypos);

      Xpos = Math.floor(Xpos);
      Ypos = Math.floor(Ypos);

      gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);                                   // basetexture
      var baseTextureValues = new Float32Array(4 * 2 * 2);
      gl.readPixels(Xpos, Ypos, 2, 2, gl.RGBA, gl.FLOAT, baseTextureValues); // order bottem up: x0y0 x1y0 x0y1 x1y1

      let temperature = KtoC(potentialToRealT(baseTextureValues[3], Ypos));

      function fract(f) { return f % 1.; }
      function mix(x, y, a) { return x * (1. - a) + y * a; }

      function bilerp(array, ind, fractX, fractY) // ind: index of value in array to get
      {
        let top = mix(array[2 * 4 + ind], array[3 * 4 + ind], fractX);
        let bottem = mix(array[0 * 4 + ind], array[1 * 4 + ind], fractX);
        return mix(bottem, top, fractY);
      }


      // Linearly interpolatate velocity
      let Vx = bilerp(baseTextureValues, 0, fractX, fractY);
      let Vy = bilerp(baseTextureValues, 1, fractX, fractY);

      let airVel = new Vec2D(this.directionIsLeft ? Vx : -Vx, Vy);

      if (this.phys.pos.y > guiControls.simHeight) {
        airVel.mult(0.0);              // still air above sim area
      } else {
        airVel.mult(cellHeight * 3.6); // convert to m/s
      }

      this.#OAT = temperature;

      // gl.readBuffer(gl.COLOR_ATTACHMENT1); // watertexture
      // var waterTextureValues = new Float32Array(4);
      // gl.readPixels(Xpos, Ypos, 1, 1, gl.RGBA, gl.FLOAT, waterTextureValues);
      // let dewpoint = KtoC(dewpoint(waterTextureValues[0]));

      gl.readBuffer(gl.COLOR_ATTACHMENT2);
      var wallTextureValues = new Int8Array(4 * 3 * 1);
      gl.readPixels(Xpos, Ypos, 3, 1, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues);

      // wrap arround the edge of the sim area
      if (Xpos == sim_res_x - 2) {
        gl.readPixels(0, Ypos, 1, 1, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues.subarray(2 * 4));
      } else if (Xpos == sim_res_x - 1) {
        gl.readPixels(0, Ypos, 2, 1, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues.subarray(1 * 4));
      }

      let radarAltL = (wallTextureValues[0 * 4 + 2] + fractY - 1.) * cellHeight;
      let radarAltM = (wallTextureValues[1 * 4 + 2] + fractY - 1.) * cellHeight;
      let radarAltR = (wallTextureValues[2 * 4 + 2] + fractY - 1.) * cellHeight;


      let radarAltFrontGear = this.directionIsLeft ? mix(radarAltL, radarAltM, Math.min(fractX + 0.14, 1.)) : mix(radarAltM, radarAltR, Math.min(fractX, 1.));

      this.#radarAltitude = Math.min(mix(radarAltL, radarAltM, fractX), mix(radarAltM, radarAltR, fractX));

      // console.log(Xpos, Ypos, radarAltL.toFixed(1), radarAltM.toFixed(1), radarAltR.toFixed(1), fractX);

      if (this.#gearStatus == 'EXTENDING') {
        this.#gearExtPos = Math.max(this.#gearExtPos - 0.01, 0.0);
        if (this.#gearExtPos == 0.0)
          this.#gearStatus = 'DOWN';
      } else if (this.#gearStatus == 'RETRACTING') {
        this.#gearExtPos = Math.min(this.#gearExtPos + 0.01, 7.0);
        if (this.#gearExtPos == 7.0)
          this.#gearStatus = 'UP';
      }

      let heightAboveGround = this.#radarAltitude;

      let heightAboveObstacles = radarAltM;

      let gearTouchAlt = 8.0 - this.#gearExtPos;

      let bounceForceMult = 100000.0;

      if (wallTextureValues[1 * 4 + 0] == 1) { // over land

        let treeHeight = map_range_C(wallTextureValues[1 * 4 + 3], 80, 127, 0., 15.);
        heightAboveObstacles -= treeHeight;

      } else if (wallTextureValues[1 * 4 + 0] == 2) { // over water
        heightAboveObstacles += 20.;
        gearTouchAlt = -5.0;                          // + (7.0 - this.#gearExtPos) * 0.2;
        bounceForceMult = 9000.0 + Math.abs(this.phys.vel.x) * 600.0;

        let draught = gearTouchAlt - heightAboveGround;
        if (draught > 0.0) {
          let waterDragForce = this.phys.vel.x * -50000.0 * draught;
          // console.log(waterDragForce);
          if (waterDragForce > 3000000 || this.#gearExtPos < 7.0) { // crash on water
            guiControls.IterPerFrame = 1;
            guiControls.auto_IterPerFrame = false;
            this.#framesSinceCrash = 0;
            soundSystem.jetEngineSound.stop();
          }

          this.phys.applyForce(new Vec2D(waterDragForce, 0.));

          this.jetEngine.stop();
        }

      } else if (wallTextureValues[1 * 4 + 0] == 4) { // over urban
        heightAboveObstacles -= 80.0;
      }

      let mainGearForce = Math.max(gearTouchAlt - heightAboveGround, 0.0) * bounceForceMult * 100.0;

      if (mainGearForce > 0.0) {
        this.#gearOnGround = true;
        mainGearForce -= this.phys.vel.y * 500000; // damping
      } else {
        this.#gearOnGround = false;
      }

      this.phys.applyForce(new Vec2D(0.0, mainGearForce), new Vec2D(1., 0.));

      let frontGearPosX = 36.0;                                                         // m

      let frontGearAlt = radarAltFrontGear + Math.sin(this.phys.angle) * frontGearPosX; // front gear altitude is not completely acurate yet

      let frontGearForce = Math.max(gearTouchAlt - frontGearAlt, 0.0) * bounceForceMult * 5.0;

      if (frontGearForce > 0.0)
        frontGearForce -= this.phys.aVel * 5000000; // damping

      this.phys.applyForce(new Vec2D(0.0, -frontGearForce), new Vec2D(-frontGearPosX, 0.));

      let gearPos = clamp(-(heightAboveGround - gearTouchAlt), 0.0, 5.0) + this.#gearExtPos; // 0 is all the way down, positive is up into the airplane

      gl.useProgram(skyBackgroundDisplayProgram);
      gl.uniform2f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'planeDirectionAndGearPos'), this.directionIsLeft, gearPos);

      if (wallTextureValues[0] != 2 && (heightAboveObstacles < 6.0 || radarAltL < 6.0 || (heightAboveObstacles < 10.0 && Math.abs(this.phys.angle) > 0.25))) { // crash into the surface
        guiControls.IterPerFrame = 1;
        guiControls.auto_IterPerFrame = false;
        this.#framesSinceCrash = 0;
        soundSystem.jetEngineSound.stop();
      }

      this.#groundSpeed = this.phys.vel.mag();

      let relVel = this.phys.vel.copy().subtract(airVel);           // velocity relative to air
      this.#airspeed = relVel.mag();                                // true airspeed in m/s
      let relAlt = this.phys.pos.y / 12000.0;                       // 12000 m = 1.0
      let relAirDensity = Math.pow(1. - relAlt * 0.47, 2.0);        // 1.0 is sea level, 0.28 is 12000 meters
      let relIndVel = relVel.copy().mult(Math.sqrt(relAirDensity)); // convert velocity relative to air to indicated, wich is also what the airplane feels

      this.#IAS = relIndVel.mag();

      // this.phys.angle += this.elevator * 0.001; // simple pitch control for testing

      // this.#relVelAngle = this.phys.vel.angle(); // ignore air movement for testing
      this.#relVelAngle = relVel.angle();


      let AOA = this.phys.angle - this.#relVelAngle;
      let dynamicPressMult = relIndVel.magSq(); // dynamic pressure
      let liftForce = this.Cl(AOA) * dynamicPressMult * 800.0;
      let dragForce = this.Cd(AOA) * dynamicPressMult * 800.0;

      // console.log(Math.round(liftForce, 1), Math.round(dragForce, 1));
      // console.log((liftForce / dragForce).toFixed(1));
      // console.log(Math.abs(this.phys.vel.x));

      let mainWingForce = new Vec2D(dragForce, liftForce);
      mainWingForce.rotate(this.#relVelAngle);
      this.phys.applyForce(mainWingForce); // Apply Main wing force at center off mass

      // console.log('this.elevator ' + this.elevator);

      let vertStabilAOA = AOA - (this.elevator * 15.0 + 3.0) * degToRad; // angled at -12 to 18 degrees relative to main wing with 3 deg center position

      // console.log('vertStabilAOA ', vertStabilAOA * radToDeg);

      let vertStabilPos = new Vec2D(35., 0.); // 35 meters to the right of the center of mass
      vertStabilPos.rotate(this.phys.angle);
      // console.log('vertStabilPos ', vertStabilPos);
      let vertStabilForce = new Vec2D(this.Cd(vertStabilAOA) * dynamicPressMult * 40.0, this.Cl(vertStabilAOA) * dynamicPressMult * 40.0);
      vertStabilForce.rotate(this.#relVelAngle);

      // console.log((vertStabilAOA * radToDeg).toFixed(2), vertStabilForce.copy().div(10000));

      let thrust = this.jetEngine.update(this.throttle);

      let thrustAltMult = 0.5 + relAirDensity * 0.5;

      this.phys.applyForce(vertStabilForce, vertStabilPos);                                        // apply vertical stabiliser force
      this.phys.applyForce(Vec2D.fromAngle(this.phys.angle, thrust * thrustAltMult * 311000 * 4)); // Thrust 4 X 311 kN
      this.phys.applyAcceleration(new Vec2D(0.0, -9.81));                                          // gravity

      let normRelVel = new Vec2D(Math.cos(this.#relVelAngle), Math.sin(this.#relVelAngle));
      let dragMult = (this.#gearStatus == 'UP' ? 25.0 : 35.0) + Math.abs(Math.sin(AOA) * 150.0);
      let dragMag = dynamicPressMult * dragMult;

      this.phys.applyForce(new Vec2D(normRelVel.x * dragMag, -normRelVel.y * dragMag));

      if (this.#gearOnGround) {
        let gearDragForce = (this.#braking ? 1100000.0 : 50000.0); // braking and wheel friction

        this.phys.applyForce(new Vec2D(this.phys.vel.x > 0.0 ? -gearDragForce : gearDragForce, 0.));
      }

      this.phys.aVel *= 1. - 0.15 * dt; // angular velocity drag

      this.phys.move(this.directionIsLeft);
    }

    hasCrashed() { return this.#framesSinceCrash >= 0; }

    setAutopilot(enabledIn)
    {
      document.body.style.cursor = enabledIn ? 'default' : 'crosshair';
      this.#autopilotEnabled = enabledIn;

      if (enabledIn == true) {
        this.#runwayThresholdPos = this.getClosestRunwayPos();
        this.#autopilot.resetState();
        this.#autopilot.targetPitch = this.phys.angle * radToDeg;
      }
    }

    calcVecToRunway()
    {
      if (this.directionIsLeft) {
        let distToRunwayY = this.phys.pos.y - this.#runwayThresholdPos.y;
        let distToRunwayX = 0;
        if (this.phys.pos.x > this.#runwayThresholdPos.x) {               // to the right of runway
          distToRunwayX = this.phys.pos.x - this.#runwayThresholdPos.x;
        } else if (this.phys.pos.x > this.#runwayThresholdPos.x - 3000) { // above runway
          distToRunwayX = 0;
        } else {                                                          // to the left of runway, wrap around map
          distToRunwayX = sim_res_x * cellHeight + (this.phys.pos.x - this.#runwayThresholdPos.x);
        }
        let vecToRunway = new Vec2D(distToRunwayX, distToRunwayY);
        return vecToRunway;
      } else {
        let distToRunwayY = this.phys.pos.y - this.#runwayThresholdPos.y;
        let distToRunwayX = 0;
        if (this.phys.pos.x < this.#runwayThresholdPos.x) {               // to the left of runway
          distToRunwayX = this.#runwayThresholdPos.x - this.phys.pos.x;
        } else if (this.phys.pos.x < this.#runwayThresholdPos.x + 3000) { // above runway
          distToRunwayX = 0;
        } else {                                                          // to the left of runway, wrap around map
          distToRunwayX = sim_res_x * cellHeight + (this.phys.pos.x - this.#runwayThresholdPos.x);
        }
        let vecToRunway = new Vec2D(distToRunwayX, distToRunwayY);
        return vecToRunway;
      }
    }

    takeUserInput()
    {
      this.prevThrottle = this.throttle;

      if (upPressed) {
        this.throttle += 0.01;
      } else if (downPressed) {
        this.throttle -= 0.01;
      }

      const [autopilotElevator, autopilotThrottle] = this.#autopilot.update(this.phys.angle * radToDeg, this.phys.pos.y, this.phys.vel, this.#IAS, this.calcVecToRunway(), this.#gearOnGround);

      this.#autopilot.targetAltitude = this.#instrumentPanel.getTargetAlt();
      this.#autopilot.targetIAS = this.#instrumentPanel.getTargetIAS();
      this.#autopilot.targetGlideslope = this.#instrumentPanel.getTargetGlideslope();

      if (this.#autopilot.autoThrottleEnabled) {
        this.throttle = autopilotThrottle;

        if (this.throttle < 0.0)
          this.#braking = true;
      }

      const gp = navigator.getGamepads()[0];

      if (this.#autopilotEnabled) {

        this.elevator = autopilotElevator;
      } else if (gp) {
        this.elevator = -gp.axes[1];
      } else {                                                              // manual elevator control
        this.elevator = (mouseY - canvas.height / 2) / canvas.height * 2.0; // pitch input -1.0 to +1.0
      }

      // this.elevator /= 1.0 + Math.max(this.#airspeed - 80, 0.) * 0.01;          // limit elevator throw at higher airspeed
      this.elevator += Math.max(-this.phys.angle * radToDeg - 50.0, 0.) * 0.03; // limit elevator to prevent going down steeper than vertical
      this.elevator -= Math.max(this.phys.angle * radToDeg - 50.0, 0.) * 0.03;  // limit elevator to prevent going up steeper than vertical

      // console.log(this.phys.angle * radToDeg, this.elevator);

      if (gp) {
        if (!this.#autopilot.autoThrottleEnabled) {
          this.throttle = (gp.axes[2] + 1.) / 2.;
          this.throttle *= -gp.axes[4]; // reverse thrust
        }
        this.#braking = gp.buttons[0].pressed;

        this.setGear(gp.axes[7] > 0.)
      }

      this.throttle = clamp(this.throttle, (this.#gearOnGround && (this.prevThrottle < 0. || this.#autopilot.autoThrottleEnabled || gp)) ? -0.3 : 0.0,
                            (this.prevThrottle > 0. || this.#autopilot.autoThrottleEnabled || gp) ? 1.0 : 0.0);
    }

    display()
    {
      let normXpos = this.phys.pos.x / cellHeight / sim_res_x;
      let normYpos = (this.phys.pos.y / cellHeight + 1.0) / sim_res_y;

      // console.log(normXpos, normYpos);
      gl.useProgram(skyBackgroundDisplayProgram);
      gl.uniform3f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'planePos'), normXpos, normYpos, this.directionIsLeft ? this.phys.angle : -this.phys.angle);
      gl.useProgram(advectionProgram);
      gl.uniform4f(gl.getUniformLocation(advectionProgram, 'airplaneValues'), normXpos, normYpos, this.throttle, this.#framesSinceCrash > 0 ? 1.0 : (zPressed ? -1.0 : 0.0));
      gl.useProgram(skyBackgroundDisplayProgram);

      if (this.#camFollow) {
        cam.tarXpos = -normXpos * 2.0 + 1.0;
        cam.tarYpos = -normYpos * 2.0 * (sim_res_y / sim_res_x) + (sim_res_y / sim_res_x);
      }

      let vecToRunway = this.calcVecToRunway();

      this.#instrumentPanel.display(this.phys.angle * radToDeg, this.#relVelAngle * radToDeg, this.phys.pos.y, this.#radarAltitude, this.#IAS, this.phys.vel, this.#OAT, this.throttle * 100.0,
                                    this.jetEngine.N1, this.elevator, this.#autopilot.targetPitch, this.#autopilotEnabled, this.#gearStatus, vecToRunway.angle() * radToDeg, vecToRunway,
                                    this.#braking);
    }
  }

  var airplane = new Airplane();

  document.body.style.overflow = 'hidden'; // prevent scrolling bar from apearing

  canvas = document.getElementById('mainCanvas');

  var contextAttributes = {
    alpha : false,
    desynchronized : false,
    antialias : true,
    depth : false,
    failIfMajorPerformanceCaveat : false,
    powerPreference : 'high-performance',
    premultipliedAlpha : true, // true
    preserveDrawingBuffer : false,
    stencil : false,
  };
  gl = canvas.getContext('webgl2', contextAttributes);
  // console.log(gl.getContextAttributes());

  if (!gl) {
    alert('Your browser does not support WebGL2, Download a new browser.');
    throw ' Error: Your browser does not support WebGL2';
  }

  // Reused gl.drawBuffers() argument arrays -- the exact same handful of attachment-list combinations get
  // passed every single simulation iteration (several times per iteration) and every render frame. Passing
  // a fresh array literal each call was a needless allocation in the hottest path in the whole program;
  // gl.drawBuffers() only reads the array synchronously and keeps no reference to it, so one shared array
  // per combination is safe to reuse indefinitely.
  var DRAWBUFFERS_0 = [ gl.COLOR_ATTACHMENT0 ];
  var DRAWBUFFERS_01 = [ gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1 ];
  var DRAWBUFFERS_012 = [ gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2 ];
  var DRAWBUFFERS_0_NONE_2 = [ gl.COLOR_ATTACHMENT0, gl.NONE, gl.COLOR_ATTACHMENT2 ];
  var DRAWBUFFERS_BACK = [ gl.BACK ];

  // SETUP GUI

  if (guiControlsFromSaveFile == null) { // use default settings
    setupDatGui(JSON.stringify(guiControls_default));
    guiControls.simHeight = sim_height;
    guiControls.globalEffectsEndAlt = sim_height;
    guiControls.windCeilingAlt = Math.round(sim_height * 0.66 / 100) * 100;

    if (applySoundingAtStart && soundingData)
      guiControls.soundingForcing = 1.0; // the sounding picked on the home screen shapes the atmosphere right away

    if (startDate) {
      guiControls.month = startDate.getMonth() + 1 + startDate.getDate() / 30.5;
    }

    if (startLatitude) {
      guiControls.latitude = startLatitude;
    }

  } else {
    setupDatGui(guiControlsFromSaveFile);                     // use settings from save file

    for (const [key, value] of Object.entries(guiControls)) { // set numerical values that could not be loaded from the savefile to their defaults.
      if (value === -1) {
        guiControls[key] = guiControls_default[key];
      }
    }
  }

  guiControls.gridResY = sim_res_y; // always reflects the live grid resolution, not a saved/default value

  // Uploads the "Limite de vent" setting (km/h, 0 = automatic) as the velocity shader's velMax (cells/iteration)
  // and the matching clamp for sounding wind targets.
  function applyWindLimit()
  {
    const kmhPerRaw = kmhPerRawVelocity(guiControls.simHeight, sim_res_y);
    if (!(guiControls.windLimitKmh > 0))
      guiControls.windLimitKmh = Math.round(WIND_LIMIT_DEFAULT_RAW * kmhPerRaw);
    const velMax = guiControls.classicWind ? 1e6 : guiControls.windLimitKmh / kmhPerRaw;
    gl.useProgram(velocityProgram);
    gl.uniform1f(gl.getUniformLocation(velocityProgram, 'velMax'), velMax);
    gl.useProgram(advectionProgram);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'shearSmoothing'), guiControls.classicWind ? 0.0 : guiControls.shearSmoothing);
    simVelTargetMax = velMax * 0.67;
    updateSoundingForcingUniforms(); // re-clamp the sounding wind targets to the new limit
  }

  function setGuiUniforms()
  { // set all uniforms to new values
    applyWindLimit();
    gl.useProgram(boundaryProgram);
    gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'vorticity'), guiControls.vorticity);
    gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'landEvaporation'), guiControls.landEvaporation);
    gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'waterEvaporation'), guiControls.waterEvaporation);
    gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'dynamicWaterTemperature'), guiControls.dynamicWaterTemperature ? 1.0 : 0.0);
    gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'evapHeat'), guiControls.evapHeat);
    gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'waterWeight'), guiControls.waterWeight);
    gl.useProgram(velocityProgram);
    gl.uniform1f(gl.getUniformLocation(velocityProgram, 'dragMultiplier'), guiControls.dragMultiplier);
    gl.uniform1f(gl.getUniformLocation(velocityProgram, 'wind'), guiControls.wind);
    gl.uniform1f(gl.getUniformLocation(velocityProgram, 'uWindMultiplier'), windMultiplier); // must never be left at WebGL's implicit 0.0 default, or all wind force is silently suppressed
    gl.uniform1f(gl.getUniformLocation(velocityProgram, 'windTaperStart'), guiControls.windCeilingAlt / guiControls.simHeight);
    gl.useProgram(lightingProgram);
    gl.uniform1f(gl.getUniformLocation(lightingProgram, 'waterTemperature'), CtoK(guiControls.waterTemperature));
    gl.uniform1f(gl.getUniformLocation(lightingProgram, 'greenhouseGases'), guiControls.greenhouseGases);
    gl.uniform1f(gl.getUniformLocation(lightingProgram, 'waterGreenHouseEffect'), guiControls.waterGreenHouseEffect);
    gl.uniform1f(gl.getUniformLocation(lightingProgram, 'IR_rate'), guiControls.IR_rate);
    gl.useProgram(advectionProgram);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'evapHeat'), guiControls.evapHeat);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'meltingHeat'), guiControls.meltingHeat);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'condensationRate'), guiControls.condensationRate);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalDrying'), guiControls.globalDrying);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalHeating'), guiControls.globalHeating);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'soundingForcing'), guiControls.soundingForcing);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalEffectsStartAlt'), guiControls.globalEffectsStartAlt / guiControls.simHeight);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalEffectsEndAlt'), guiControls.globalEffectsEndAlt / guiControls.simHeight);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'windTaperStart'), guiControls.windCeilingAlt / guiControls.simHeight);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'shearSmoothing'), guiControls.classicWind ? 0.0 : guiControls.shearSmoothing);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'cellHeightM'), guiControls.simHeight / sim_res_y);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'dtSeconds'), timePerIteration * 3600);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'waterTemperature'), CtoK(guiControls.waterTemperature));
    gl.useProgram(precipitationProgram);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'evapHeat'), guiControls.evapHeat);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'meltingHeat'), guiControls.meltingHeat);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'aboveZeroThreshold'), guiControls.aboveZeroThreshold);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'subZeroThreshold'), guiControls.subZeroThreshold);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'spawnChanceMult'), guiControls.spawnChance);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'snowDensity'), guiControls.snowDensity);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'fallSpeed'), guiControls.fallSpeed);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'growthRate0C'), guiControls.growthRate0C);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'growthRate_30C'), guiControls.growthRate_30C);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'freezingRate'), guiControls.freezingRate);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'meltingRate'), guiControls.meltingRate);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'evapRate'), guiControls.evapRate);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'lightningEnabled'), guiControls.lightningEnabled ? 1.0 : 0.0);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'hailEnabled'), guiControls.hailEnabled ? 1.0 : 0.0);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'hailCapeThreshold'), guiControls.hailCapeThreshold);
    gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'hailMeltingRate'), guiControls.hailMeltingRate);
    gl.useProgram(postProcessingProgram);
    gl.uniform1f(gl.getUniformLocation(postProcessingProgram, 'exposure'), guiControls.exposure);
  }

  function setupDatGui(strGuiControls)
  {
    dat.GUI.TEXT_CLOSED = 'Fermer les réglages';
    dat.GUI.TEXT_OPEN = 'Ouvrir les réglages';
    datGui = new dat.GUI();
    guiControls = JSON.parse(strGuiControls); // load settings object

    for (const [key, value] of Object.entries(guiControls_default)) // settings added after a save file was made get their default
      if (guiControls[key] === undefined)
        guiControls[key] = value;

    guiControls.tool = 'TOOL_NONE';

    cam.wrapHorizontally = guiControls.wrapHorizontally;
    cam.smooth = guiControls.SmoothCam;

    if (guiControls.wrapHorizontally)
      horizontalDisplayMult = 3.0;
    else
      horizontalDisplayMult = 1.0;


    if (frameNum == 0) {
      // only hide during initial setup. When resetting settings and
      // reinitializing datGui, H key no longer works to unhide it
      datGui.hide();
    }
    // add functions to guicontrols object
    guiControls.download = function() { prepareDownload(); };

    guiControls.resetWind = startWindReset; // smoothly fades guiControls.wind to 0 over a few seconds -- see startWindReset()

    guiControls.resetSettings = function() {
      if (confirm('Are you sure you want to reset all settings to default?')) {
        datGui.destroy();                                 // remove datGui completely
        setupDatGui(JSON.stringify(guiControls_default)); // generate new one with new settings
        setGuiUniforms();
        hideOrShowGraph();
        updateSunlight();
      }
    };

    var fluidParams_folder = datGui.addFolder('Fluide');

    fluidParams_folder.add(guiControls, 'vorticity', 0.0, 0.010, 0.001)
      .onChange(function() {
        gl.useProgram(boundaryProgram);
        gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'vorticity'), guiControls.vorticity);
      })
      .name('Vorticité');

    fluidParams_folder.add(guiControls, 'dragMultiplier', 0.0, 1.0, 0.01)
      .onChange(function() {
        gl.useProgram(velocityProgram);
        gl.uniform1f(gl.getUniformLocation(velocityProgram, 'dragMultiplier'), guiControls.dragMultiplier);
      })
      .name('Frottement');

    fluidParams_folder.add(guiControls, 'wind', -1.0, 1.0, 0.01)
      .onChange(function() {
        gl.useProgram(velocityProgram);
        gl.uniform1f(gl.getUniformLocation(velocityProgram, 'wind'), guiControls.wind);
      })
      .name('Vent')
      .listen(); // stays in sync with the live value while startWindReset() is animating it down

    fluidParams_folder.add(guiControls, 'resetWind').name('Réinitialiser les vents');

    // Wind ceiling: the wind force and the sounding's wind target both fade smoothly to 0 between this
    // altitude and the top of the map, so jet-stream winds never slam into the rigid top boundary. Set it to
    // the full sim height to disable.
    // Wind speed limit: the sim's pressure waves move 1 cell per iteration, so how fast the wind can get before the
    // flow becomes unstable depends on the cell size (coarser vertical resolution = faster stable winds).
    {
      const simHeightNow = guiControlsFromSaveFile == null ? sim_height : guiControls.simHeight;
      const kmhPerRaw = kmhPerRawVelocity(simHeightNow, sim_res_y);
      if (!(guiControls.windLimitKmh > 0))
        guiControls.windLimitKmh = Math.round(WIND_LIMIT_DEFAULT_RAW * kmhPerRaw);
      fluidParams_folder.add(guiControls, 'windLimitKmh', 20, Math.round(kmhPerRaw * 0.9), 5)
        .onChange(function() {
          applyWindLimit();
        })
        .name('Limite de vent (km/h)');
      const hint = fluidParams_folder.__controllers[fluidParams_folder.__controllers.length - 1];
      hint.domElement.parentElement.parentElement.title = 'Vitesse du son du simulateur à cette résolution : ' + Math.round(kmhPerRaw) +
        ' km/h. Au-delà de ~' + Math.round(kmhPerRaw * 0.6) + ' km/h le calcul devient instable. Pour des jet-streams plus rapides, réduisez la résolution verticale (cellules plus grandes).';
    }

    fluidParams_folder.add(guiControls, 'shearSmoothing', 0.0, 1.0, 0.05)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'shearSmoothing'), guiControls.classicWind ? 0.0 : guiControls.shearSmoothing);
      })
      .name('Dégradé du vent');

    fluidParams_folder.add(guiControls, 'classicWind')
      .onChange(applyWindLimit) // re-uploads velMax and shearSmoothing for the chosen mode
      .name('Physique du vent d\'origine');

    fluidParams_folder.add(guiControls, 'windCeilingAlt', 1000, guiControls.simHeight, 100)
      .onChange(function() {
        const taperStart = guiControls.windCeilingAlt / guiControls.simHeight;
        gl.useProgram(velocityProgram);
        gl.uniform1f(gl.getUniformLocation(velocityProgram, 'windTaperStart'), taperStart);
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'windTaperStart'), taperStart);
      })
      .name('Plafond du vent (m)')
      .listen();

    fluidParams_folder.add(guiControls, 'globalDrying', 0.0, 0.0001, 0.000001)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalDrying'), guiControls.globalDrying);
      })
      .name('Assèchement global');

    fluidParams_folder.add(guiControls, 'globalHeating', -0.001, 0.001, 0.00001)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalHeating'), guiControls.globalHeating);
      })
      .name('Réchauffement global');

    // , 0, 1.0, 0.01
    fluidParams_folder.add(guiControls, 'soundingForcing', 0, 1.0, 0.01)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'soundingForcing'), guiControls.soundingForcing);
      })
      .name('Forçage du sondage')
      .listen(); // also set from code: at start when a home-screen sounding is applied, and by loadStationForForcing()

    // Right next to the Sounding Forcing slider itself, not just as the separate on-screen marker bar --
    // switching the real Meteociel station driving that forcing is a single click here.
    fluidParams_folder.add(guiControls, 'activeSoundingStation', Object.keys(soundingStations))
      .name('Lieu du sondage')
      .onChange(function() { loadStationForForcing(guiControls.activeSoundingStation); })
      .listen(); // stays in sync when a station is instead picked from the on-screen marker bar

    // One-time seed from whatever the setup screen had configured, so the in-game date starts somewhere
    // sensible -- from here on, getInGameSoundingEpochTime() (used by loadStationForForcing()) reads ONLY
    // guiControls.soundingDate/soundingHour, never lastSoundingEpochTime again. Date/hour controls themselves
    // now live in the glassmorphism widget built by setupSoundingDateTimeWidget(), not dat.GUI (see below).
    if (lastSoundingEpochTime !== null) {
      const seedDate = new Date(lastSoundingEpochTime * 1000);
      guiControls.soundingDate = seedDate.toISOString().slice(0, 10);
      guiControls.soundingHour = seedDate.getUTCHours();
    }

    fluidParams_folder.add(guiControls, 'showStationMarkers')
      .name('Afficher la barre des lieux')
      .onChange(function() {
        const bar = document.getElementById('stationMarkersBar');
        const status = document.getElementById('stationMarkerStatus');
        const dateTimeWidget = document.getElementById('soundingDateTimeWidget');
        if (bar)
          bar.style.display = guiControls.showStationMarkers ? 'block' : 'none';
        if (status)
          status.style.display = guiControls.showStationMarkers ? 'block' : 'none';
        if (dateTimeWidget)
          dateTimeWidget.style.display = guiControls.showStationMarkers ? 'flex' : 'none';
      });

    fluidParams_folder.open(); // Sounding Forcing + station switcher should be visible immediately, not behind a collapsed folder

    fluidParams_folder.add(guiControls, 'globalEffectsEndAlt', 0, guiControls.simHeight, 10)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        if (guiControls.globalEffectsEndAlt < guiControls.globalEffectsStartAlt) {
          guiControls.globalEffectsStartAlt = guiControls.globalEffectsEndAlt;
          gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalEffectsStartAlt'), guiControls.globalEffectsStartAlt / guiControls.simHeight);
        }
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalEffectsEndAlt'), guiControls.globalEffectsEndAlt / guiControls.simHeight);
      })
      .listen()
      .name('Appliquer en dessous de (m)');

    fluidParams_folder.add(guiControls, 'globalEffectsStartAlt', 0, guiControls.simHeight, 10)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        if (guiControls.globalEffectsStartAlt > guiControls.globalEffectsEndAlt) {
          guiControls.globalEffectsEndAlt = guiControls.globalEffectsStartAlt;
          gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalEffectsEndAlt'), guiControls.globalEffectsEndAlt / guiControls.simHeight);
        }

        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'globalEffectsStartAlt'), guiControls.globalEffectsStartAlt / guiControls.simHeight);
      })
      .listen()
      .name('Appliquer au-dessus de (m)');

    fluidParams_folder.add(guiControls, 'CAPE', 0, 4000, 50)
      .listen()
      .name('CAPE (J/kg, direct)')
      .domElement.style.pointerEvents = 'none'; // read-only: CAPE is computed from the sounding, not a settable input


    var UI_folder = datGui.addFolder('Outils');

    UI_folder
      .add(guiControls, 'tool', {
        'Lampe torche' : 'TOOL_NONE',
        'Température' : 'TOOL_TEMPERATURE',
        'Vapeur / nuage' : 'TOOL_WATER',
        'Terre' : 'TOOL_WALL_LAND',
        'Lac / mer' : 'TOOL_WALL_SEA',
        'Ville' : 'TOOL_WALL_URBAN',
        'Piste' : 'TOOL_WALL_RUNWAY',
        'Industrie' : 'TOOL_WALL_INDUSTRIAL',
        'Feu' : 'TOOL_WALL_FIRE',
        'Fumée / poussière' : 'TOOL_SMOKE',
        'Humidité du sol' : 'TOOL_WALL_MOIST',
        'Végétation' : 'TOOL_VEGETATION',
        'Neige' : 'TOOL_WALL_SNOW',
        'Vent' : 'TOOL_WIND',
        'Station météo' : 'TOOL_STATION',
      })
      .name('Outil')
      .listen();
    UI_folder.add(guiControls, 'brushSize', 1, 200, 1).name('Diamètre du pinceau').listen();
    UI_folder.add(guiControls, 'wholeWidth').name('Pinceau pleine largeur').listen();
    UI_folder.add(guiControls, 'brushIntensity', 0.005, 0.05, 0.001).name('Intensité du pinceau');
    UI_folder.add(guiControls, 'allowCaves')
      .onChange(function() {
        gl.useProgram(boundaryProgram);
        gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'allowCaves'), guiControls.allowCaves ? 1 : 0);
      })
      .name('Autoriser les grottes');

    var radiation_folder = datGui.addFolder('Rayonnement');

    radiation_folder.add(guiControls, 'timeOfDay', 0.0, 23.96, 0.01).onChange(onUpdateTimeOfDaySlider).name('Heure').listen();

    radiation_folder.add(guiControls, 'dayNightCycle').name('Cycle jour/nuit').listen();

    radiation_folder.add(guiControls, 'accelerateNight').name('Accélérer la nuit').listen();

    radiation_folder.add(guiControls, 'latitude', -90.0, 90.0, 0.1).onChange(function() { updateSunlight(); }).name('Latitude').listen();

    radiation_folder.add(guiControls, 'month', 1.0, 12.99, 0.01).onChange(onUpdateMonthSlider).name('Mois').listen();

    radiation_folder.add(guiControls, 'sunAngle', -10.0, 190.0, 0.1)
      .onChange(function() {
        updateSunlight('MANUAL_ANGLE');
        guiControls.dayNightCycle = false;
      })
      .name('Angle du soleil')
      .listen();

    radiation_folder.add(guiControls, 'sunIntensity', 0.0, 2.0, 0.01).onChange(function() { updateSunlight('MANUAL_ANGLE'); }).name('Intensité du soleil');

    radiation_folder.add(guiControls, 'greenhouseGases', 0.0, 0.01, 0.0001)
      .onChange(function() {
        gl.useProgram(lightingProgram);
        gl.uniform1f(gl.getUniformLocation(lightingProgram, 'greenhouseGases'), guiControls.greenhouseGases);
      })
      .name('Gaz à effet de serre');

    radiation_folder.add(guiControls, 'waterGreenHouseEffect', 0.0, 0.01, 0.0001)
      .onChange(function() {
        gl.useProgram(lightingProgram);
        gl.uniform1f(gl.getUniformLocation(lightingProgram, 'waterGreenHouseEffect'), guiControls.waterGreenHouseEffect);
      })
      .name('Effet de serre de la vapeur');

    radiation_folder
      .add(guiControls, 'IR_rate', 0.0, 10.0, 0.1)
      /*.onChange(function() {
        gl.useProgram(lightingProgram);
        gl.uniform1f(gl.getUniformLocation(lightingProgram, 'IR_rate'), guiControls.IR_rate);
      })*/
      .name('Multiplicateur IR');

    var water_folder = datGui.addFolder('Eau');

    water_folder.add(guiControls, 'waterTemperature', 0.0, 40.0, 0.1)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'waterTemperature'), CtoK(guiControls.waterTemperature));
        gl.useProgram(lightingProgram);
        gl.uniform1f(gl.getUniformLocation(lightingProgram, 'waterTemperature'), CtoK(guiControls.waterTemperature));
      })
      .name('Température lac / mer (°C)');

    water_folder.add(guiControls, 'dynamicWaterTemperature').name('Température de l\'eau dynamique').onChange(function() {
      gl.useProgram(boundaryProgram);
      gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'dynamicWaterTemperature'), guiControls.dynamicWaterTemperature ? 1.0 : 0.0);
    });

    water_folder.add(guiControls, 'landEvaporation', 0.0, 0.0002, 0.00001)
      .onChange(function() {
        gl.useProgram(boundaryProgram);
        gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'landEvaporation'), guiControls.landEvaporation);
      })
      .name('Évaporation du sol');
    water_folder.add(guiControls, 'waterEvaporation', 0.0, 0.0004, 0.00001)
      .onChange(function() {
        gl.useProgram(boundaryProgram);
        gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'waterEvaporation'), guiControls.waterEvaporation);
      })
      .name('Évaporation lac / mer');
    water_folder.add(guiControls, 'evapHeat', 0.0, 5.0, 0.1)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'evapHeat'), guiControls.evapHeat);
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'evapHeat'), guiControls.evapHeat);
        gl.useProgram(boundaryProgram);
        gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'evapHeat'), guiControls.evapHeat);
      })
      .name('Chaleur d\'évaporation');
    water_folder.add(guiControls, 'meltingHeat', 0.0, 5.0, 0.1)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'meltingHeat'), guiControls.meltingHeat);
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'meltingHeat'), guiControls.meltingHeat);
      })
      .name('Chaleur de fusion');
    water_folder.add(guiControls, 'condensationRate', 0.001, 0.020, 0.001)
      .onChange(function() {
        gl.useProgram(advectionProgram);
        gl.uniform1f(gl.getUniformLocation(advectionProgram, 'condensationRate'), guiControls.condensationRate);
      })
      .listen()
      .name('Vitesse de condensation');
    water_folder.add(guiControls, 'waterWeight', 0.0, 2.0, 0.01)
      .onChange(function() {
        gl.useProgram(boundaryProgram);
        gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'waterWeight'), guiControls.waterWeight);
      })
      .name('Poids de l\'eau');

    var precipitation_folder = datGui.addFolder('Précipitations');

    precipitation_folder.add(guiControls, 'aboveZeroThreshold', 0.1, 2.0, 0.001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'aboveZeroThreshold'), guiControls.aboveZeroThreshold);
      })
      .name('Seuil de précipitation > 0 °C');

    precipitation_folder.add(guiControls, 'subZeroThreshold', 0.0, 1.0, 0.001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'subZeroThreshold'), guiControls.subZeroThreshold);
      })
      .name('Seuil de précipitation < 0 °C');

    precipitation_folder.add(guiControls, 'spawnChance', 0.00001, 0.0001, 0.00001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'spawnChanceMult'), guiControls.spawnChance);
      })
      .name('Taux d\'apparition')
      .listen();

    precipitation_folder.add(guiControls, 'snowDensity', 0.1, 0.9, 0.01)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'snowDensity'), guiControls.snowDensity);
      })
      .name('Densité de la neige');

    precipitation_folder.add(guiControls, 'fallSpeed', 0.0001, 0.001, 0.0001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'fallSpeed'), guiControls.fallSpeed);
      })
      .name('Vitesse de chute');

    precipitation_folder.add(guiControls, 'growthRate0C', 0.0001, 0.005, 0.0001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'growthRate0C'), guiControls.growthRate0C);
      })
      .name('Croissance à 0 °C');

    precipitation_folder.add(guiControls, 'growthRate_30C', 0.0001, 0.005, 0.0001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'growthRate_30C'), guiControls.growthRate_30C);
      })
      .name('Croissance à -30 °C');

    precipitation_folder
      .add(guiControls, 'freezingRate', 0.0005, 0.01, 0.0001) // 0.0035
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'freezingRate'), guiControls.freezingRate);
      })
      .name('Vitesse de congélation');

    precipitation_folder
      .add(guiControls, 'meltingRate', 0.0005, 0.01, 0.0001) // 0.0035
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'meltingRate'), guiControls.meltingRate);
      })
      .name('Vitesse de fonte');

    precipitation_folder.add(guiControls, 'evapRate', 0.0001, 0.005, 0.0001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'evapRate'), guiControls.evapRate);
      })
      .name('Vitesse d\'évaporation');

    precipitation_folder.add(guiControls, 'inactiveDroplets', 0, NUM_DROPLETS).listen().name('Gouttes inactives');

    precipitation_folder.add(guiControls, 'lightningEnabled')
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'lightningEnabled'), guiControls.lightningEnabled ? 1.0 : 0.0);
      })
      .name('Activer la foudre');

    precipitation_folder.add(guiControls, 'hailEnabled')
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'hailEnabled'), guiControls.hailEnabled ? 1.0 : 0.0);
      })
      .name('Activer la grêle');

    precipitation_folder.add(guiControls, 'hailCapeThreshold', 500, 4000, 50)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'hailCapeThreshold'), guiControls.hailCapeThreshold);
      })
      .name('Seuil CAPE pour la grêle');

    precipitation_folder.add(guiControls, 'hailMeltingRate', 0.0001, 0.01, 0.0001)
      .onChange(function() {
        gl.useProgram(precipitationProgram);
        gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'hailMeltingRate'), guiControls.hailMeltingRate);
      })
      .name('Vitesse de fonte (Température au sol)');


    var tornado_folder = datGui.addFolder('Alerte tornade');

    tornado_folder.add(guiControls, 'sirenMuted').name('Couper la sirène').listen().onChange(updateSirenToggleButton);

    tornado_folder.add(guiControls, 'showTornadoWarning').name('Icône et trajectoire d\'alerte');


    var display_folder = datGui.addFolder('Affichage');

    display_folder
      .add(guiControls, 'displayMode', {
        '1 Température -26 à 30 °C' : 'DISP_TEMPERATURE',
        '2 Vapeur d\'eau' : 'DISP_WATER',
        '3 Réaliste' : 'DISP_REAL',
        '4 Vent horizontal' : 'DISP_HORIVEL',
        '5 Vent vertical' : 'DISP_VERTVEL',
        '6 Chauffage / refroidissement IR' : 'DISP_IRHEATING',
        '7 IR descendant -60 à 26 °C' : 'DISP_IRDOWNTEMP',
        '8 IR montant -26 à 30 °C' : 'DISP_IRUPTEMP',
        '9 Masse de précipitations' : 'DISP_PRECIPFEEDBACK_MASS',
        'Précipitations : chauffage/refroidissement' : 'DISP_PRECIPFEEDBACK_HEAT',
        'Précipitations : condensation/évaporation' : 'DISP_PRECIPFEEDBACK_VAPOR',
        'Cumul de pluie' : 'DISP_PRECIPFEEDBACK_RAIN',
        'Cumul de neige' : 'DISP_PRECIPFEEDBACK_SNOW',
        'Précipitations / humidité du sol' : 'DISP_SOIL_MOISTURE',
        'Rotationnel' : 'DISP_CURL',
        'Humidité relative / densité des nuages' : 'DISP_HUMD',
        'Qualité de l\'air' : 'DISP_AIRQUALITY'
      })
      .name('Mode d\'affichage')
      .listen();
    display_folder.add(guiControls, 'exposure', 0.5, 5.0, 0.01)
      .onChange(function() {
        gl.useProgram(postProcessingProgram);
        gl.uniform1f(gl.getUniformLocation(postProcessingProgram, 'exposure'), guiControls.exposure);
      })
      .name('Exposition');

    display_folder.add(guiControls, 'camSpeed', 0.001, 0.050, 0.001).name('Vitesse de la caméra');


    display_folder.add(guiControls, 'wrapHorizontally')
      .onChange(function() {
        cam.wrapHorizontally = guiControls.wrapHorizontally;
        cam.center();
        if (guiControls.wrapHorizontally)
          horizontalDisplayMult = 3.0;
        else
          horizontalDisplayMult = 1.0;
      })
      .name('Boucler horizontalement');

    display_folder.add(guiControls, 'SmoothCam').onChange(function() { cam.smooth = guiControls.SmoothCam; }).name('Caméra fluide');

    display_folder.add(guiControls, 'showGraph').onChange(hideOrShowGraph).name('Afficher le sondage').listen();

    // Wind display scale for mode 4: the original fixed scale saturates at ~25-50 km/h, so a jet stream showed as
    // a uniform red band. Full color now corresponds to an adjustable speed (0 = original scale).
    {
      const simHeightNow = guiControlsFromSaveFile == null ? sim_height : guiControls.simHeight;
      const kmhPerRaw = kmhPerRawVelocity(simHeightNow, sim_res_y);
      if (!(guiControls.windDisplayKmh > 0))
        guiControls.windDisplayKmh = Math.round(0.1 * kmhPerRaw);
      const applyWindDisplay = () => { windDisplayMultiplier = kmhPerRaw / guiControls.windDisplayKmh; };
      applyWindDisplay();
      display_folder.add(guiControls, 'windDisplayKmh', 10, 400, 5).onChange(applyWindDisplay).name('Échelle du vent affiché (km/h)');
    }

    display_folder.add(guiControls, 'skyEffects')
      .onChange(function() {
        gl.useProgram(skyBackgroundDisplayProgram);
        gl.uniform1f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'skyEffects'), guiControls.skyEffects ? 1.0 : 0.0);
      })
      .name('Ciel réaliste (soleil, lune, étoiles)');
    display_folder.add(guiControls, 'showDrops').name('Afficher les gouttes').listen();
    display_folder.add(guiControls, 'realDewPoint').name('Point de rosée réel');


    display_folder.add(guiControls, 'twelveHourClock').name('Horloge 12 h');

    display_folder
      .add(guiControls, 'lengthUnit', {
        'km / m / cm / mm' : 'LENGTH_UNIT_METRIC',
        'miles / pieds / pouces' : 'LENGTH_UNIT_IMPERIAL',
      })
      .name('Unité de longueur')
      .onChange(function() {
        for (i = 0; i < weatherStations.length; i++) {
          weatherStations[i].clearChart();
        }
      });

    display_folder
      .add(guiControls, 'speedUnit', {
        'km/h' : 'SPEED_UNIT_KMH',
        'm/s' : 'SPEED_UNIT_MS',
        'mph' : 'SPEED_UNIT_MPH',
        'kt' : 'SPEED_UNIT_KT',
      })
      .name('Unité de vitesse')
      .onChange(function() {
        for (i = 0; i < weatherStations.length; i++) {
          weatherStations[i].clearChart();
        }
      });

    display_folder
      .add(guiControls, 'tempUnit', {
        '°C' : 'TEMP_UNIT_C',
        '°F' : 'TEMP_UNIT_F',
        'K' : 'TEMP_UNIT_K',
      })
      .name('Unité de température')
      .onChange(function() {
        for (i = 0; i < weatherStations.length; i++) {
          weatherStations[i].clearChart();
        }
      });


    var advanced_folder = datGui.addFolder('Avancé');

    advanced_folder.add(guiControls, 'enablePrecipitation')
      .onChange(function() {
        initRainDrops();
        setupPrecipitationBuffers();
        guiControls.inactiveDroplets = NUM_DROPLETS;
      })
      .name('Activer les précipitations');

    advanced_folder.add(guiControls, 'IterPerFrame', 1, 50, 1).onChange(function() { guiControls.auto_IterPerFrame = false; }).name('Itérations / image').listen();

    advanced_folder.add(guiControls, 'auto_IterPerFrame').name('Ajustement auto').listen();


    advanced_folder.add(guiControls, 'sound').name('Activer le son').onChange(function() {
      if (guiControls.sound) {
        if (soundSystem == null) {
          soundSystem = new SoundSystem();
        }
      } else {
        soundSystem?.mute();
      }
    });

    advanced_folder.add(guiControls, 'STP', 0, 10, 0.1)
      .listen()
      .name('STP (direct)')
      .domElement.style.pointerEvents = 'none'; // read-only: STP is derived from CAPE/CIN/shear, not a settable input

    advanced_folder.add(guiControls, 'gridResY', 100, 600, 10)
      .listen()
      .name('Hauteur de grille (redémarre)')
      .onFinishChange(function() {
        if (guiControls.gridResY == sim_res_y)
          return;

        if (confirm('Changer la hauteur de la grille nécessite de redémarrer la simulation. Le monde actuel sera perdu. Continuer ?')) {
          localStorage.setItem('pendingGridResY', guiControls.gridResY);
          location.reload();
        } else {
          guiControls.gridResY = sim_res_y; // revert slider to the current live resolution
        }
      });

    advanced_folder.add(guiControls, 'resetSettings').name('Réinitialiser tous les réglages');

    datGui.add(guiControls, 'paused').onChange(handlePause).name('Pause').listen();
    datGui.add(guiControls, 'download').name('Sauvegarder la simulation');

    datGui.width = 400;
  }

  // guiControls.paused = true; // pause before first iteration for debugging

  await loadingBar.set(3, 'Initializing Sounding Graph');
  // END OF GUI

  function startSimulation()
  {
    SETUP_MODE = false;
    gl.useProgram(postProcessingProgram);
    gl.uniform1f(gl.getUniformLocation(postProcessingProgram, 'exposure'), guiControls.exposure);
    datGui.show(); // unhide

    clockEl = document.createElement('div');
    document.body.appendChild(clockEl);

    clockEl.innerHTML = ''
    clockEl.style.position = 'absolute';
    clockEl.style.fontFamily = 'Monospace';
    clockEl.style.fontSize = '35px';
    clockEl.style.color = 'white';

    atmosStatsEl = document.createElement('div');
    document.body.appendChild(atmosStatsEl);

    atmosStatsEl.innerHTML = '';
    atmosStatsEl.style.position = 'absolute';
    atmosStatsEl.style.top = '45px';
    atmosStatsEl.style.left = '0px';
    atmosStatsEl.style.fontFamily = 'Monospace';
    atmosStatsEl.style.fontSize = '16px';
    atmosStatsEl.style.color = 'white';
    atmosStatsEl.style.textShadow = '1px 1px 2px black';

    sirenToggleEl = document.createElement('button');
    document.body.appendChild(sirenToggleEl);
    sirenToggleEl.style.position = 'absolute';
    sirenToggleEl.style.top = '75px';
    sirenToggleEl.style.left = '0px';
    sirenToggleEl.style.zIndex = 3;
    sirenToggleEl.style.fontFamily = 'Monospace';
    sirenToggleEl.style.fontSize = '15px';
    sirenToggleEl.style.color = 'white';
    sirenToggleEl.style.border = '1px solid white';
    sirenToggleEl.style.borderRadius = '4px';
    sirenToggleEl.style.padding = '4px 8px';
    sirenToggleEl.style.cursor = 'pointer';
    sirenToggleEl.title = 'Activer/désactiver l\'alarme de sirène de tornade';
    sirenToggleEl.addEventListener('click', function() {
      guiControls.sirenMuted = !guiControls.sirenMuted;
      updateSirenToggleButton();
    });
    updateSirenToggleButton();

    tornadoWarningCanvas = document.createElement('canvas');
    document.body.appendChild(tornadoWarningCanvas);
    tornadoWarningCanvas.width = canvas.width;
    tornadoWarningCanvas.height = canvas.height;
    tornadoWarningCanvas.style.position = 'absolute';
    tornadoWarningCanvas.style.top = '0px';
    tornadoWarningCanvas.style.left = '0px';
    tornadoWarningCanvas.style.pointerEvents = 'none'; // never intercept clicks/drags meant for the sim underneath
    tornadoWarningCanvas.style.zIndex = 2;
    tornadoWarningCtx = tornadoWarningCanvas.getContext('2d');

    setupStationMarkers();
    setupSoundingDateTimeWidget();
    setupWindResetUI();

    simDateTime = new Date(2000, Math.floor(guiControls.month) - 1, (guiControls.month % 1) * 30.417);

    // initialize time and solar angle
    if (guiControls.dayNightCycle) {
      onUpdateTimeOfDaySlider();
      onUpdateMonthSlider();
    } else {
      updateSunlight('MANUAL_ANGLE'); // set angle from savefile
    }
  }

  // Reads guiControls.soundingDate/soundingHour -- set by the date/hour widget (setupSoundingDateTimeWidget())
  // -- the ONLY source of truth for which date/hour in-game station switching loads. Returns null (via
  // parseIsoDateToEpoch()) if the date isn't well-formed YYYY-MM-DD.
  function getInGameSoundingEpochTime()
  {
    return parseIsoDateToEpoch(guiControls.soundingDate, guiControls.soundingHour);
  }

  function setForcingStatus(text, kind)
  {
    const statusEl = document.getElementById('stationMarkerStatus');
    if (!statusEl)
      return;
    statusEl.textContent = '';
    statusEl.appendChild(svgIcon({success : 'check', error : 'alert', loading : 'loader'}[kind] || 'pin'));
    statusEl.appendChild(document.createTextNode(text.replace(/^[✓⚠]\s*/, '')));
    statusEl.dataset.kind = kind || '';
  }

  // Shared by the marker bar, the "Sounding Station" dropdown next to the Sounding Forcing slider, the
  // in-game city search and the date/hour widget: the one place that fetches a sounding and pushes it
  // live into the running simulation, keeping every station-switching control in sync afterward.
  let forcingRequestId = 0;
  async function loadStationForForcing(key)
  {
    const station = soundingStations[key];
    if (!station) {
      setForcingStatus('⚠ Lieu inconnu : ' + key, 'error');
      return false;
    }

    const epochTime = getInGameSoundingEpochTime();
    if (epochTime === null) {
      setForcingStatus('⚠ Date invalide (format attendu : AAAA-MM-JJ).', 'error');
      return false;
    }

    const requestId = ++forcingRequestId;
    setForcingStatus('Chargement du sondage — ' + key + ' · ' + formatSoundingTime(epochTime) + '…', 'loading');

    const result = await loadSoundingAt(station, epochTime);

    if (requestId !== forcingRequestId)
      return false; // superseded by a newer click

    if (!result) {
      setForcingStatus(epochTime < OPEN_METEO_START_EPOCH ? '⚠ Pas de données avant le 23/03/2021 pour ' + key + '.'
                                                          : '⚠ Sondage indisponible pour ' + key + ' (connexion ?).', 'error');
      return false;
    }

    soundingData = result.table;
    updateSoundingForcingUniforms(); // live-updates what the running sim's soundingForcing pulls toward

    guiControls.activeSoundingStation = key; // syncs the dropdown (its .listen()) even when picked from the marker bar instead

    if (guiControls.soundingForcing < 0.05) { // a sounding the player explicitly picked should visibly do something
      guiControls.soundingForcing = 1.0;
      gl.useProgram(advectionProgram);
      gl.uniform1f(gl.getUniformLocation(advectionProgram, 'soundingForcing'), guiControls.soundingForcing);
    }

    const bar = document.getElementById('stationMarkersBar');
    if (bar) {
      for (const b of bar.querySelectorAll('button[data-station-key]'))
        b.classList.toggle('active', b.dataset.stationKey === key);
    }

    setForcingStatus('✓ ' + soundingSourceLabel(result.source) + ' — ' + key + ' · ' + formatSoundingTime(epochTime), 'success');
    return true;
  }

  // Location pins overlaid at the bottom of the game view -- click one to load ITS sounding (at the date/hour
  // set in the widget) into the running sim's Sounding Forcing. The searched city (custom) comes first.
  function setupStationMarkers()
  {
    const bar = document.createElement('div');
    bar.id = 'stationMarkersBar';
    bar.className = 'station-markers-bar';
    document.body.appendChild(bar);
    bar.style.display = guiControls.showStationMarkers ? 'block' : 'none';

    const statusEl = document.createElement('div');
    statusEl.id = 'stationMarkerStatus';
    statusEl.className = 'station-marker-status';
    document.body.appendChild(statusEl);
    statusEl.style.display = guiControls.showStationMarkers ? 'block' : 'none';

    const keys = Object.keys(soundingStations).sort((a, b) => (soundingStations[b].custom ? 1 : 0) - (soundingStations[a].custom ? 1 : 0));

    for (const key of keys)
      bar.appendChild(createStationMarkerButton(key));
  }

  function createStationMarkerButton(key)
  {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.appendChild(svgIcon(soundingStations[key].custom ? 'pin' : soundingStations[key].id ? 'balloon' : 'star'));
    btn.appendChild(document.createTextNode(key));
    btn.title = 'Charger le sondage de ' + key;
    btn.dataset.stationKey = key;
    btn.classList.toggle('active', key === guiControls.activeSoundingStation);
    btn.addEventListener('click', function() { loadStationForForcing(key); });
    return btn;
  }

  // Floating date/hour widget for the in-game Sounding Forcing, with a city search so ANY place can be loaded
  // without going back to the home screen. Any change writes guiControls.soundingDate/soundingHour (read by
  // getInGameSoundingEpochTime()) and immediately reloads the active location via loadStationForForcing().
  function setupSoundingDateTimeWidget()
  {
    const widget = document.createElement('div');
    widget.id = 'soundingDateTimeWidget';
    widget.className = 'sounding-datetime-widget';
    document.body.appendChild(widget);
    widget.style.display = guiControls.showStationMarkers ? 'flex' : 'none';

    // Keyboard shortcuts are global (keydown on document); typing in these inputs must not trigger them.
    widget.addEventListener('keydown', event => event.stopPropagation());
    widget.addEventListener('keyup', event => event.stopPropagation());

    const cityInput = document.createElement('input');
    cityInput.type = 'text';
    cityInput.placeholder = 'Ville… (Entrée)';
    cityInput.className = 'widget-city-input';
    cityInput.title = 'Tapez une ville puis Entrée pour charger son sondage';
    widget.appendChild(cityInput);

    cityInput.addEventListener('keydown', async function(event) {
      if (event.key !== 'Enter')
        return;
      const query = cityInput.value.trim();
      if (query.length < 2)
        return;
      setForcingStatus('Recherche de « ' + query + ' »…', 'loading');
      try {
        const places = await geocodePlaces(query);
        if (places.length === 0) {
          setForcingStatus('⚠ Aucun lieu trouvé pour « ' + query + ' »', 'error');
          return;
        }
        const p = places[0];
        const key = p.country ? p.name + ', ' + p.country : p.name;
        soundingStations[key] = {id : null, lat : p.lat, lon : p.lon, custom : true};
        const bar = document.getElementById('stationMarkersBar');
        if (bar && !Array.from(bar.children).some(b => b.dataset.stationKey === key))
          bar.prepend(createStationMarkerButton(key));
        cityInput.value = '';
        cityInput.blur();
        loadStationForForcing(key);
      } catch (err) {
        setForcingStatus('⚠ Recherche indisponible (hors ligne ?)', 'error');
      }
    });

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.id = 'soundingDateInput';
    dateInput.value = guiControls.soundingDate;
    dateInput.max = new Date(Date.now() + SOUNDING_MAX_FORECAST_DAYS * 86400 * 1000).toISOString().slice(0, 10);
    widget.appendChild(dateInput);

    const hourButtons = [];
    for (const hour of [ 0, 6, 12, 18 ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hour-btn';
      btn.textContent = String(hour).padStart(2, '0') + 'Z';
      btn.addEventListener('click', function() {
        guiControls.soundingHour = hour;
        refreshHourButtons();
        loadStationForForcing(guiControls.activeSoundingStation);
      });
      hourButtons.push({hour, btn});
      widget.appendChild(btn);
    }

    function refreshHourButtons()
    {
      for (const {hour, btn} of hourButtons)
        btn.classList.toggle('active', guiControls.soundingHour === hour);
    }
    refreshHourButtons();

    // Light debounce: the native date picker's spinner arrows/keyboard can fire several 'change' events in
    // quick succession while the player is still settling on a day.
    let dateInputDebounceId = null;
    dateInput.addEventListener('change', function() {
      if (dateInputDebounceId !== null)
        clearTimeout(dateInputDebounceId);
      dateInputDebounceId = setTimeout(function() {
        dateInputDebounceId = null;
        guiControls.soundingDate = dateInput.value;
        loadStationForForcing(guiControls.activeSoundingStation);
      }, 350);
    });
  }

  // Progress bar shown while startWindReset() fades guiControls.wind to 0.
  function setupWindResetUI()
  {
    const box = document.createElement('div');
    box.id = 'windResetProgress';
    document.body.appendChild(box);
    box.style.position = 'fixed';
    box.style.left = '50%';
    box.style.top = '20px';
    box.style.transform = 'translateX(-50%)';
    box.style.zIndex = 5;
    box.style.fontFamily = 'Monospace';
    box.style.color = 'white';
    box.style.background = 'rgba(0, 0, 0, 0.55)';
    box.style.padding = '8px 14px';
    box.style.borderRadius = '6px';
    box.style.textAlign = 'center';
    box.style.display = 'none';

    const label = document.createElement('div');
    label.id = 'windResetProgressLabel';
    label.style.fontSize = '13px';
    label.style.marginBottom = '4px';
    box.appendChild(label);

    const track = document.createElement('div');
    track.style.width = '220px';
    track.style.height = '8px';
    track.style.background = 'rgba(255, 255, 255, 0.2)';
    track.style.borderRadius = '4px';
    track.style.overflow = 'hidden';
    box.appendChild(track);

    const fill = document.createElement('div');
    fill.id = 'windResetProgressFill';
    fill.style.height = '100%';
    fill.style.width = '0%';
    fill.style.background = '#4a90e2';
    box.style.transition = 'width 0.1s linear';
    track.appendChild(fill);
  }

  var windResetAnimationId = null;

  // 1.0 = normal; ramped to 0.0 by startWindReset() below. Uploaded to BOTH velocityProgram (scales the
  // global wind force) and advectionProgram (scales the Sounding Forcing's own wind injection, and drives
  // a small Rayleigh-friction damping term on base[VX] while below 1.0) -- see the uniform declarations in
  // velocityShader.frag / advectionShader.frag. Never touches the velocity grid directly.
  var windMultiplier = 1.0;

  function uploadWindMultiplier()
  {
    gl.useProgram(velocityProgram);
    gl.uniform1f(gl.getUniformLocation(velocityProgram, 'uWindMultiplier'), windMultiplier);

    gl.useProgram(advectionProgram);
    gl.uniform1f(gl.getUniformLocation(advectionProgram, 'uWindMultiplier'), windMultiplier);
  }

  // Reset Wind touches ONLY existing shader uniforms via a plain lerp over 5 seconds -- it never reaches
  // into the velocity grid (base[VX]/base[VY]) directly. Directly rewriting the velocity field bypasses
  // the pressure-projection step that keeps it divergence-free, injecting spurious divergence the solver
  // then has to fight -- visible as vertical-line artifacts. Three things fade to 0 together:
  //  1) guiControls.wind, the global wind bias (base[VX] += wind * uWindMultiplier * 1e-6 in velocityProgram);
  //  2) windMultiplier itself, which ALSO scales the Sounding Forcing's own wind injection in
  //     advectionProgram (velDiff * ... * uWindMultiplier) to nothing;
  //  3) a small Rayleigh friction term in advectionProgram, proportional to (1 - uWindMultiplier), which
  //     gently bleeds off whatever momentum the fluid already has while (1)/(2) are cutting the forcing --
  //     without it, existing wind would just keep advecting under its own inertia once the forces feeding
  //     it are gone, since neither (1) nor (2) erase momentum that already exists.
  // Once uWindMultiplier reaches 0 (forces cut, friction at its gentle peak), the solver settles the
  // remaining motion out on its own. At the end, guiControls.wind is snapped to exactly 0, the sounding's
  // wind profile is cleared to 0 (uploaded directly, "vide" rather than merely scaled), and uWindMultiplier
  // is restored to 1.0 so the player can bring wind back in afterward -- the friction term then reads
  // (1 - 1) = 0 and is inert again.
  // Shows #windResetProgress while it runs. Re-triggering while already running just restarts cleanly from
  // whatever the current values are. Bound to guiControls.resetWind (the dat.GUI "Réinitialiser les vents"
  // button). The Wind slider has .listen() so it visually tracks guiControls.wind falling during this.
  function startWindReset()
  {
    if (windResetAnimationId !== null)
      cancelAnimationFrame(windResetAnimationId);

    const progressEl = document.getElementById('windResetProgress');
    const labelEl = document.getElementById('windResetProgressLabel');
    const fillEl = document.getElementById('windResetProgressFill');

    const startWind = guiControls.wind;
    const startWindMultiplier = windMultiplier;
    const durationMs = 5000;
    const startTime = performance.now();

    if (progressEl)
      progressEl.style.display = 'block';

    let lastDisplayedPct = -1; // only touch the DOM when the rounded percentage actually changes -- at 60fps
                                // over a 5s animation most frames round to the same value as the previous one

    function tick(now)
    {
      const t = clamp((now - startTime) / durationMs, 0, 1); // lerp factor: 0 at the start, 1 at the end

      guiControls.wind = mixGeneric(startWind, 0, t);
      gl.useProgram(velocityProgram);
      gl.uniform1f(gl.getUniformLocation(velocityProgram, 'wind'), guiControls.wind);

      windMultiplier = mixGeneric(startWindMultiplier, 0, t);
      uploadWindMultiplier();

      const pct = Math.round(t * 100);
      if (pct !== lastDisplayedPct) {
        lastDisplayedPct = pct;
        if (labelEl)
          labelEl.textContent = 'Réinitialisation des vents : ' + pct + '%...';
        if (fillEl)
          fillEl.style.width = pct + '%';
      }

      if (t < 1) {
        windResetAnimationId = requestAnimationFrame(tick);
      } else {
        guiControls.wind = 0;
        gl.useProgram(velocityProgram);
        gl.uniform1f(gl.getUniformLocation(velocityProgram, 'wind'), 0);

        // Empty the sounding's wind profile outright (not just scaled) before restoring the multiplier.
        gl.useProgram(advectionProgram);
        gl.uniform4fv(gl.getUniformLocation(advectionProgram, 'realWorldSounding_Velv'), new Float32Array(608));

        windMultiplier = 1.0; // disengage: forces are already at 0 and the profile is empty, so this is a no-op until wind/a new station reintroduces something
        uploadWindMultiplier();

        windResetAnimationId = null;
        if (progressEl)
          progressEl.style.display = 'none';
      }
    }

    windResetAnimationId = requestAnimationFrame(tick);
  }

  // Keeps guiControls.CAPE/STP (and therefore hail spawning, which reads guiControls.CAPE as its
  // instability signal every simulation iteration) updating every frame even when the sounding graph
  // panel is closed. Without this, CAPE/STP were only ever computed inside soundingGraph.draw(), which
  // only runs while guiControls.showGraph is true -- meaning in normal play (panel closed, the default)
  // CAPE stayed frozen at 0 forever and hail could never spawn at all, regardless of any visual/audio fix.
  function updateAtmosStatsForHail(simXpos)
  {
    simXpos = clamp(Math.floor(simXpos), 0, sim_res_x - 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    var baseTextureValues = new Float32Array(4 * sim_res_y);
    gl.readPixels(simXpos, 0, 1, sim_res_y, gl.RGBA, gl.FLOAT, baseTextureValues); // read a vertical column of cells

    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    var waterTextureValues = new Float32Array(4 * sim_res_y);
    gl.readPixels(simXpos, 0, 1, sim_res_y, gl.RGBA, gl.FLOAT, waterTextureValues);

    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    var wallTextureValues = new Int32Array(4 * sim_res_y);
    gl.readPixels(simXpos, 0, 1, sim_res_y, gl.RGBA_INTEGER, gl.INT, wallTextureValues);

    var reachedAir = false;
    var surfaceLevel;

    for (var y = 0; y < sim_res_y; y++) {
      if (wallTextureValues[4 * y + 1] != 0) { // first fluid (non-wall) cell = the surface
        reachedAir = true;
        surfaceLevel = y;
        break;
      }
    }

    if (!reachedAir)
      return; // camera centered entirely over a wall/void column: nothing to compute

    const parcelIndices = calcParcelIndices(baseTextureValues, waterTextureValues, wallTextureValues, surfaceLevel);
    const shear = calcBulkShear(baseTextureValues, surfaceLevel);
    const STP = calcSTP(parcelIndices.CAPE, parcelIndices.CIN, parcelIndices.LCL_height, shear.shear06, shear.shear01);

    lastAtmosStats = {
      CAPE : parcelIndices.CAPE,
      CIN : parcelIndices.CIN,
      LCL_height : parcelIndices.LCL_height,
      shear06 : shear.shear06,
      STP : STP,
    };

    guiControls.CAPE = lastAtmosStats.CAPE;
    guiControls.STP = lastAtmosStats.STP;

    // Tornado detection: STP > 10 is an extreme value reserved for the most violent setups, and this 2D
    // sandbox has no real funnel cloud, so "the funnel reaches the ground" is approximated as the cloud
    // itself (CLOUD channel) extending down to near the surface layer, rather than staying lofted above it.
    const lowLevelBandCells = Math.max(Math.round((sim_res_y * 300.0) / guiControls.simHeight), 1); // ~300m band above the surface
    let cloudNearSurface = 0.0;
    for (let y = surfaceLevel + 1; y <= Math.min(surfaceLevel + lowLevelBandCells, sim_res_y - 1); y++) {
      cloudNearSurface = Math.max(cloudNearSurface, waterTextureValues[4 * y + 1]); // CLOUD channel
    }

    const tornadoActive = STP > 10.0 && cloudNearSurface > 0.5;

    if (tornadoActive) {
      // Mean wind over the lowest ~3km, used to project the tornado's likely path.
      const y3km = Math.min(surfaceLevel + Math.round(3000.0 / (guiControls.simHeight / sim_res_y)), sim_res_y - 1);
      let meanWindX = 0.0;
      let sampleCount = 0;
      for (let y = surfaceLevel; y <= y3km; y++) {
        meanWindX += baseTextureValues[4 * y + 0];
        sampleCount++;
      }
      meanWindX /= Math.max(sampleCount, 1);

      tornadoWarning.active = true;
      tornadoWarning.simX = simXpos;
      tornadoWarning.simY = surfaceLevel;
      tornadoWarning.windX = meanWindX;
    } else {
      tornadoWarning.active = false;
    }
  }

  // NWS/NOAA-style tornado warning overlay: a red/orange warning triangle plus a dashed projected-path
  // arrow in the mean low-level wind direction, drawn on a transparent 2D canvas above the WebGL canvas.
  function drawTornadoWarning()
  {
    if (!tornadoWarningCtx)
      return;

    tornadoWarningCtx.clearRect(0, 0, tornadoWarningCanvas.width, tornadoWarningCanvas.height);

    if (!guiControls.showTornadoWarning || !tornadoWarning.active)
      return;

    const c = tornadoWarningCtx;
    const x = simToScreenX(tornadoWarning.simX);
    const y = simToScreenY(tornadoWarning.simY);

    // Projected path: dashed arrow pointing in the mean low-level wind direction
    const dirX = tornadoWarning.windX >= 0 ? 1 : -1;
    const pathLength = 180;

    c.save();
    c.strokeStyle = '#FF9900';
    c.lineWidth = 3;
    c.setLineDash([10, 8]);
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + dirX * pathLength, y);
    c.stroke();
    c.setLineDash([]);

    c.beginPath();
    c.moveTo(x + dirX * pathLength, y);
    c.lineTo(x + dirX * (pathLength - 14), y - 8);
    c.lineTo(x + dirX * (pathLength - 14), y + 8);
    c.closePath();
    c.fillStyle = '#FF9900';
    c.fill();
    c.restore();

    // NWS-style warning triangle (red/orange, white exclamation mark)
    const size = 28;
    c.save();
    c.translate(x, y - 50);
    c.beginPath();
    c.moveTo(0, -size);
    c.lineTo(size * 0.87, size * 0.5);
    c.lineTo(-size * 0.87, size * 0.5);
    c.closePath();
    c.fillStyle = 'rgba(255, 60, 0, 0.85)';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = '#FFFFFF';
    c.stroke();

    c.fillStyle = '#FFFFFF';
    c.font = 'bold 26px Arial';
    c.textAlign = 'center';
    c.fillText('!', 0, size * 0.32);
    c.restore();

    c.fillStyle = '#FF3C00';
    c.font = 'bold 14px Arial';
    c.textAlign = 'center';
    c.fillText('ALERTE TORNADE', x, y - 85);
  }

  var soundingGraph = {
    graphCanvas : null,
    ctx : null,
    init : function() {
      this.graphCanvas = document.getElementById('graphCanvas');
      this.graphCanvas.height = window.innerHeight;
      this.graphCanvas.width = this.graphCanvas.height;
      this.ctx = this.graphCanvas.getContext('2d');
      var style = this.graphCanvas.style;
      if (guiControls.showGraph)
        style.display = 'block';
      else
        style.display = 'none';
    },
    draw : function(simXpos, simYpos) {
      // draw graph
      // mouse positions in sim coordinates

      gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      var baseTextureValues = new Float32Array(4 * sim_res_y);
      gl.readPixels(simXpos, 0, 1, sim_res_y, gl.RGBA, gl.FLOAT,
                    baseTextureValues); // read a vertical culumn of cells

      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      var waterTextureValues = new Float32Array(4 * sim_res_y);
      gl.readPixels(simXpos, 0, 1, sim_res_y, gl.RGBA, gl.FLOAT, waterTextureValues); // read a vertical culumn of cells

      gl.readBuffer(gl.COLOR_ATTACHMENT2);
      var wallTextureValues = new Int32Array(4 * sim_res_y);
      gl.readPixels(simXpos, 0, 1, sim_res_y, gl.RGBA_INTEGER, gl.INT, wallTextureValues); // read a vertical column of cells


      const graphBottem = this.graphCanvas.height - 40; // in pixels

      var c = this.ctx;

      c.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
      c.fillStyle = '#00000055';
      c.fillRect(0, 0, graphCanvas.width, graphCanvas.height);

      drawIsotherms();

      var reachedAir = false;
      var surfaceLevel;

      // Draw temperature line
      c.beginPath();
      for (var y = 0; y < sim_res_y; y++) {
        var potentialTemp = baseTextureValues[4 * y + 3];

        var temp = potentialTemp - ((y / sim_res_y) * guiControls.simHeight * guiControls.dryLapseRate) / 1000.0 - 273.15;

        var scrYpos = map_range(y, sim_res_y, 0, 0, graphBottem);

        c.font = '15px Arial';
        c.fillStyle = 'white';

        if (wallTextureValues[4 * y + 1] != 0) { // if this is fluid cell
          if (!reachedAir) {
            // first non wall cell
            reachedAir = true;
            surfaceLevel = y;

            if (simYpos < surfaceLevel)
              simYpos = surfaceLevel;
          }
          if (reachedAir && y == simYpos) {
            // c.fillText('' + Math.round(map_range(y-1, 0, sim_res_y, 0,
            // guiControls.simHeight)) + ' m', 5, scrYpos + 5);
            c.strokeStyle = '#FFF';
            c.lineWidth = 1.0;
            c.strokeRect(T_to_Xpos(temp, scrYpos), scrYpos, 10,
                         1); // vertical position indicator
            c.fillText('' + printTemp(temp), T_to_Xpos(temp, scrYpos) + 20, scrYpos + 5);
          }

          c.lineTo(T_to_Xpos(temp, scrYpos), scrYpos);  // temperature
        } else if (wallTextureValues[4 * y + 2] == 0) { // is surface layer
          if (wallTextureValues[4 * y + 0] != 2) {      // is land, urban or fire
            c.fillStyle = 'white';
            c.lineWidth = 1.0;

            let soilMoisture_mm = waterTextureValues[4 * y + 2];
            if (soilMoisture_mm > 0.) {
              c.fillText('💧' + printSoilMoisture(soilMoisture_mm), 65, scrYpos + 17);
            }

            let snowHeight_cm = waterTextureValues[4 * y + 3];
            if (snowHeight_cm > 0.) {
              c.fillText('❄' + printSnowHeight(snowHeight_cm), 160, scrYpos + 17); // display snow height
            }
          } else if (wallTextureValues[4 * y + 0] == 2) {                          // is water
            c.fillStyle = 'lightblue';
            c.lineWidth = 1.0;
            let waterTempC = KtoC(potentialTemp);                                                           // water temperature is stored as absolute, not dependant on height
            c.fillText('🌊 🌡' + printTemp(waterTempC), T_to_Xpos(waterTempC, scrYpos) - 33, scrYpos + 17); // display water surface temperature
          }
        }
      }
      c.lineWidth = 2.0; // 3
      c.strokeStyle = '#FF0000';
      c.stroke();


      // Compute and display CAPE / CIN / STP for this column (surface-based parcel)
      if (reachedAir) {
        const parcelIndices = calcParcelIndices(baseTextureValues, waterTextureValues, wallTextureValues, surfaceLevel);
        const shear = calcBulkShear(baseTextureValues, surfaceLevel);
        const STP = calcSTP(parcelIndices.CAPE, parcelIndices.CIN, parcelIndices.LCL_height, shear.shear06, shear.shear01);

        lastAtmosStats = {
          CAPE : parcelIndices.CAPE,
          CIN : parcelIndices.CIN,
          LCL_height : parcelIndices.LCL_height,
          shear06 : shear.shear06,
          STP : STP,
        };

        // feed the read-only dat.GUI gauges (CAPE / STP folders), picked up via .listen()
        guiControls.CAPE = lastAtmosStats.CAPE;
        guiControls.STP = lastAtmosStats.STP;

        c.font = '16px Arial';
        c.fillStyle = 'yellow';
        c.fillText('SBCAPE: ' + lastAtmosStats.CAPE.toFixed(0) + ' J/kg', 10, 20);
        c.fillText('CIN: ' + lastAtmosStats.CIN.toFixed(0) + ' J/kg', 10, 40);
        c.fillText('LCL: ' + printAltitude(lastAtmosStats.LCL_height), 10, 60);
        c.fillText('Shear 0-6km: ' + printVelocity(lastAtmosStats.shear06), 10, 80);
        c.fillStyle = lastAtmosStats.STP >= 1.0 ? '#FF4444' : 'yellow';
        c.fillText('STP: ' + lastAtmosStats.STP.toFixed(2), 10, 100);
      }


      // Draw wind indicators
      c.beginPath();
      for (var y = surfaceLevel; y < sim_res_y; y++) {

        var scrYpos = map_range(y, sim_res_y, 0, 0, graphBottem);

        var velocity = rawVelocityTo_ms(baseTextureValues[4 * y]); // horizontal wind velocity

        let Xpos = this.graphCanvas.width - 70;

        c.moveTo(Xpos, scrYpos);
        c.lineTo(Xpos + velocity * 2.5, scrYpos); // draw line segment
      }

      c.lineWidth = 2.0; // 3
      c.strokeStyle = '#666666';
      c.stroke();


      // Draw Dew point line
      c.beginPath();
      for (var y = surfaceLevel; y < sim_res_y; y++) {

        if (wallTextureValues[4 * y + 1] != 0) { // fluid cell

          var dewPoint = KtoC(dewpoint(waterTextureValues[4 * y]));

          var temp = baseTextureValues[4 * y + 3] - ((y / sim_res_y) * guiControls.simHeight * guiControls.dryLapseRate) / 1000.0;
          if (guiControls.realDewPoint) {
            dewPoint = Math.min(KtoC(temp), dewPoint);
          }

          var scrYpos = map_range(y, sim_res_y, 0, 0, graphBottem);

          var velocity = rawVelocityTo_ms(Math.sqrt(Math.pow(baseTextureValues[4 * y], 2) + Math.pow(baseTextureValues[4 * y + 1], 2)));

          c.font = '15px Arial';
          c.fillStyle = 'white';

          // c.fillText('Surface: ' + y, 10, scrYpos);
          if (y == simYpos) {
            c.fillText('' + printAltitude(map_range(y - 1, 0, sim_res_y, 0, guiControls.simHeight)), 5, scrYpos + 5);

            let rh = relativeHumd(temp, waterTextureValues[4 * y]);

            if (guiControls.realDewPoint) {
              rh = Math.min(rh, 100.0);
            }

            c.fillText(rh.toFixed(1) + ' %', this.graphCanvas.width - 180, scrYpos + 20);

            c.fillText('' + printVelocity(velocity), this.graphCanvas.width - 113, scrYpos + 20);


            c.strokeStyle = '#FFF';
            c.lineWidth = 1.0;


            c.strokeRect(T_to_Xpos(dewPoint, scrYpos) - 10, scrYpos, 10,
                         1); // vertical position indicator
            c.fillText('' + printTemp(dewPoint), T_to_Xpos(dewPoint, scrYpos) - 70, scrYpos + 5);
          }

          c.lineTo(T_to_Xpos(dewPoint, scrYpos), scrYpos); // draw line segment
        }
      }

      c.lineWidth = 2.0; // 3
      c.strokeStyle = '#0055FF';
      c.stroke();

      // Draw rising parcel temperature line
      var water = waterTextureValues[4 * simYpos];
      var potentialTemp = baseTextureValues[4 * simYpos + 3];
      var initialTemperature = potentialTemp - ((simYpos / sim_res_y) * guiControls.simHeight * guiControls.dryLapseRate) / 1000.0;
      var initialCloudWater = waterTextureValues[4 * simYpos + 1];
      // var temp = potentialTemp - ((y / sim_res_y) * guiControls.simHeight *
      // guiControls.dryLapseRate) / 1000.0 - 273.15;
      var prevTemp = initialTemperature;
      var prevCloudWater = initialCloudWater;

      var drylapsePerCell = ((-1.0 / sim_res_y) * guiControls.simHeight * guiControls.dryLapseRate) / 1000.0;

      reachedSaturation = false;

      c.beginPath();
      var scrYpos = map_range(simYpos, sim_res_y, 0, 0, graphBottem);
      c.moveTo(T_to_Xpos(KtoC(initialTemperature), scrYpos), scrYpos);
      for (var y = simYpos + 1; y < sim_res_y; y++) {
        var dT = drylapsePerCell;

        var cloudWater = Math.max(water - maxWater(prevTemp + dT),
                                  0.0); // how much cloud water there would be after that
        // temperature change

        var dWt = (cloudWater - prevCloudWater) * guiControls.evapHeat; // how much that water phase change would
        // change the temperature

        var actualTempChange = dT_saturated(dT, dWt);

        var T = prevTemp + actualTempChange;

        var scrYpos = map_range(y, sim_res_y, 0, 0, graphBottem);

        c.lineTo(T_to_Xpos(KtoC(T), scrYpos), scrYpos); // temperature

        prevTemp = T;
        prevCloudWater = Math.max(water - maxWater(prevTemp), 0.0);

        if (!reachedSaturation && prevCloudWater > 0.0) {
          reachedSaturation = true;
          c.strokeStyle = '#008800'; // dark green for dry lapse rate
          c.stroke();

          if (y - simYpos > 5) {
            c.beginPath();
            c.moveTo(T_to_Xpos(KtoC(T), scrYpos) - 0, scrYpos); // temperature
            c.lineTo(T_to_Xpos(KtoC(T), scrYpos) + 40,
                     scrYpos);                                  // Horizontal ceiling line
            c.strokeStyle = '#FFFFFF';
            c.stroke();
            c.fillText('' + printAltitude(Math.round(map_range(y - 1, 0, sim_res_y, 0, guiControls.simHeight))), T_to_Xpos(KtoC(T), scrYpos) + 50, scrYpos + 5);
          }

          c.beginPath();
          c.moveTo(T_to_Xpos(KtoC(T), scrYpos), scrYpos); // temperature
        }
      }

      c.lineWidth = 2.0;           // 3
      if (reachedSaturation) {
        c.strokeStyle = '#00FF00'; // light green for saturated lapse rate
      } else
        c.strokeStyle = '#008800';

      c.stroke();


      c.fillText('' + printDistance(map_range(simXpos, 0, sim_res_y, 0, guiControls.simHeight)), this.graphCanvas.width - 70, 20);


      function T_to_Xpos(T, y)
      {
        // temperature to horizontal position
        var normX = T * 0.0115 + 1.18 - (y / graphBottem) * 0.8; // -30 to 50
        return normX * this.graphCanvas.width;                   // T * 7.5 + 780.0 - 600.0 * (y / graphBottem);
      }

      function drawIsotherms()
      {
        c.strokeStyle = '#964B00';
        c.beginPath();
        c.fillStyle = 'white';

        for (var T = -80.0; T <= 50.0; T += 10.0) {
          c.moveTo(T_to_Xpos(T, graphBottem), graphBottem);
          c.lineTo(T_to_Xpos(T, 0), 0);

          if (T >= -30.0)
            c.fillText(printTemp(Math.round(T)), T_to_Xpos(T, graphBottem) - 20, this.graphCanvas.height - 5);
        }
        c.lineWidth = 1.0;
        c.stroke();
        // draw 0 degree line thicker
        c.beginPath();
        c.moveTo(T_to_Xpos(0, graphBottem), graphBottem);
        c.lineTo(T_to_Xpos(0, 0), 0);
        c.lineWidth = 3.0;
        c.stroke();
      }
    }, // end of draw()
  };
  soundingGraph.init();

  await loadingBar.set(6, 'Setting up eventlisteners');
  // END OF GRAPH


  sim_aspect = sim_res_x / sim_res_y;

  var canvas_aspect;

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.display = 'block';
  canvas_aspect = canvas.width / canvas.height;

  var mouseXinSim, mouseYinSim;
  var prevMouseXinSim, prevMouseYinSim;

  window.addEventListener('resize', function() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas_aspect = canvas.width / canvas.height;

    soundingGraph.graphCanvas.height = window.innerHeight;
    soundingGraph.graphCanvas.width = window.innerHeight;

    if (tornadoWarningCanvas) {
      tornadoWarningCanvas.width = canvas.width;
      tornadoWarningCanvas.height = canvas.height;
    }

    // Render output framebuffers need to match canvas resolution
    createBloomFBOs(); // recreate bloom framebuffers
    createHdrFBO();    // recreate hdr framebuffer
  });

  function logSample()
  {
    // mouse position in sim coordinates
    var simXpos = Math.floor(Math.abs(mod(mouseXinSim * sim_res_x, sim_res_x)));
    var simYpos = Math.min(Math.max(Math.floor(mouseYinSim * sim_res_y), 0), sim_res_y - 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);                                         // basetexture
    var baseTextureValues = new Float32Array(4);
    gl.readPixels(simXpos, simYpos, 1, 1, gl.RGBA, gl.FLOAT, baseTextureValues); // read single cell at mouse position

    // gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
    gl.readBuffer(gl.COLOR_ATTACHMENT1); // watertexture
    var waterTextureValues = new Float32Array(4);
    gl.readPixels(simXpos, simYpos, 1, 1, gl.RGBA, gl.FLOAT, waterTextureValues);

    gl.readBuffer(gl.COLOR_ATTACHMENT2); // walltexture
    var wallTextureValues = new Int8Array(4);
    gl.readPixels(simXpos, simYpos, 1, 1, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues);

    gl.bindFramebuffer(gl.FRAMEBUFFER, lightFrameBuff_0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); // lighttexture_1
    var lightTextureValues = new Float32Array(4);
    gl.readPixels(simXpos, simYpos, 1, 1, gl.RGBA, gl.FLOAT, lightTextureValues);

    gl.bindFramebuffer(gl.FRAMEBUFFER, precipitationFeedbackFrameBuff);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    var precipitationFeedbackTextureValues = new Float32Array(4);
    gl.readPixels(simXpos, simYpos, 1, 1, gl.RGBA, gl.FLOAT, precipitationFeedbackTextureValues);

    console.log(' ');
    console.log(' ');
    console.log('Sample at:      X: ' + simXpos + ' (' + simXpos * cellHeight / 1000 + ' km)', '  Y: ' + simYpos + ' (' + simYpos * cellHeight / 1000 + ' km)');
    console.log('BASE-----------------------------------------');
    console.log('[0] X-vel:', baseTextureValues[0]);
    console.log('[1] Y-vel:', baseTextureValues[1]);
    console.log('[2] Press:', baseTextureValues[2]);
    console.log('[3] Temp :', baseTextureValues[3].toFixed(2) + ' K   ', KtoC(baseTextureValues[3]).toFixed(2) + ' °C   ', KtoC(potentialToRealT(baseTextureValues[3], simYpos)).toFixed(2) + ' °C');

    console.log('WATER-----------------------------------------');
    console.log('[0] Water:     ', waterTextureValues[0]);
    console.log('[1] Cloudwater:', waterTextureValues[1]);
    console.log('[2] Soil Moisture / Precipitation:', waterTextureValues[2]);
    console.log('[3] Smoke/snow:', waterTextureValues[3]);

    console.log('WALL-----------------------------------------');
    console.log('[0] walltype :         ', wallTextureValues[0]);
    console.log('[1] distance:          ', wallTextureValues[1]);
    console.log('[2] Vertical distance :', wallTextureValues[2]);
    console.log('[3] Vegetation:        ', wallTextureValues[3]);

    console.log('LIGHT-----------------------------------------');
    console.log('[0] Sunlight:  ', lightTextureValues[0].toFixed(2), 'W/m²');
    console.log('[1] IR Heating:', (lightTextureValues[1] / 0.000002).toFixed(2), 'W/m²  (includes sunlight absorbed by smoke)'); // net effect of ir
    console.log('[2] IR down:   ', lightTextureValues[2].toFixed(2), 'W/m²', KtoC(IR_temp(lightTextureValues[2])).toFixed(2) + ' °C');
    console.log('[3] IR up:     ', lightTextureValues[3].toFixed(2), 'W/m²', KtoC(IR_temp(lightTextureValues[3])).toFixed(2) + ' °C');
    console.log('Net IR up:     ', (lightTextureValues[3] - lightTextureValues[2]).toFixed(2), 'W/m²');

    console.log('PRECIPITATION FEEDBACK-------------------------');
    console.log('[0] Mass:  ', precipitationFeedbackTextureValues[0]);
    console.log('[1] Heat:', precipitationFeedbackTextureValues[1]); // net effect of ir
    console.log('[2] Vapor:   ', precipitationFeedbackTextureValues[2]);
    console.log('[3] Snow deposition:     ', precipitationFeedbackTextureValues[3]);
  }


  var middleMousePressed = false;
  var leftMousePressed = false;
  var prevMouseX = 0;
  var prevMouseY = 0;
  var mouseX = 0;
  var mouseY = 0;
  var ctrlPressed = false;
  var rightCtrlPressed = false;
  var bPressed = false;
  var leftPressed = false;
  var downPressed = false;
  var rightPressed = false;
  var upPressed = false;
  var plusPressed = false;
  var minusPressed = false;
  var zPressed = false;


  // EVENT LISTENERS

  addEventListener('beforeunload', (event) => {
    if (new Date() - lastSaveTime > 120000) { // more than 120 seconds
      event.preventDefault();
      // custom message not showing for some reason
      confirm('Are you sure you want to quit without saving?');
      event.returnValue = 0; // Google Chrome requires returnValue to be set.
    }
  });

  window.addEventListener('wheel', function(event) {
    var delta = 0.1;
    if (event.deltaY > 0)
      delta *= -1;
    if (typeof lastWheel == 'undefined')
      lastWheel = 0; // init static variable
    const now = new Date().getTime();

    if (bPressed) {
      guiControls.brushSize *= 1.0 + delta * 1.0;
      if (guiControls.brushSize < 1)
        guiControls.brushSize = 1;
      else if (guiControls.brushSize > 200)
        guiControls.brushSize = 200;
    } else {
      if (now - lastWheel > 20) {
        // change zoom
        lastWheel = now;

        cam.zoomAtMousePos(delta);
      }
    }
  });

  window.addEventListener('mousemove', function(event) {
    var rect = canvas.getBoundingClientRect();
    mouseX = event.clientX - rect.left;

    if (!(guiControls.tool == 'TOOL_WALL_SEA' && leftMousePressed)) // lock y pos while drawing lake / sea
      mouseY = event.clientY - rect.top;

    if (middleMousePressed) {
      cam.changeViewXpos(((mouseX - prevMouseX) / cam.curZoom / canvas.width) * 2.0);
      cam.changeViewYpos(-((mouseY - prevMouseY) / cam.curZoom / canvas.width) * 2.0);
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    }
  });

  canvas.addEventListener('mousedown', function(e) { mouseDownEvent(e); });
  graphCanvas.addEventListener('mousedown', function(e) { mouseDownEvent(e); });


  function findSimYposAboveSurfaceAtMouseX() // find the lowest location that is not underground
  {
    let simXpos = clamp(Math.floor(mouseXinSim * sim_res_x), 0, sim_res_x - 1);
    let simYpos = clamp(Math.floor(mouseYinSim * sim_res_y), 0, sim_res_y - 1);
    // console.log(simYpos)

    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
    gl.readBuffer(gl.COLOR_ATTACHMENT2); // walltexture

    var wallTextureValues = new Int8Array(4 * sim_res_y);
    gl.readPixels(simXpos, 0, 1, sim_res_y, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues); // read a vertical culumn of cells

    if (wallTextureValues[simYpos * 4 + 1] > 0) {                                         // place at mouse position of cell is not wall
      return simYpos;
    } else {
      for (let curSimYpos = simYpos; curSimYpos < sim_res_y; curSimYpos++) { // find first cell above that is not wall
        if (wallTextureValues[curSimYpos * 4 + 1] > 0) {                     // surface reached
          return curSimYpos;
        }
      }
    }
  }

  function mouseDownEvent(e)
  {
    // event.preventDefault(); // caused problems with dat.gui
    // console.log('mousedown');
    if (e.button == 0) { // left
      leftMousePressed = true;
      if (SETUP_MODE) {
        startSimulation();
      } else if (guiControls.tool == 'TOOL_STATION') {
        let simXpos = Math.floor(mouseXinSim * sim_res_x);
        let simYpos = findSimYposAboveSurfaceAtMouseX();

        if (simXpos >= 0 && simXpos < sim_res_x)
          weatherStations.push(new Weatherstation(simXpos, simYpos)); // add weather station
      }
    } else if (e.button == 1) {
      // middle mouse button
      middleMousePressed = true;
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    }
  }


  window.addEventListener('mouseup', function(event) {
    if (event.button == 0) {
      leftMousePressed = false;
    } else if (event.button == 1) {
      // middle mouse button
      middleMousePressed = false;
    }
  });


  var wasTwoFingerTouchBefore = false;

  var previousTouches;


  canvas.addEventListener('touchstart', function(event) { event.preventDefault(); }, {passive : false});

  canvas.addEventListener('touchend', function(event) {
    event.preventDefault();
    if (event.touches.length == 0) { // all fingers released
      leftMousePressed = false;
      //   }else if(event.touches.length == 1){
      wasTwoFingerTouchBefore = false;
      previousTouches = null;

      if (SETUP_MODE) {
        startSimulation();
      }
    }
  }, {passive : false});

  canvas.addEventListener('touchmove', function(event) {
    event.preventDefault();

    if (event.touches.length == 1) { // single finger

      // console.log(event.touches[0]);
      if (!wasTwoFingerTouchBefore) {
        leftMousePressed = true; // treat just like holding left mouse button
        mouseX = event.touches[0].clientX;
        mouseY = event.touches[0].clientY;
      }
    } else {
      leftMousePressed = false;

      if (event.touches.length == 2 && previousTouches && previousTouches.length == 2) // 2 finger zoom
      {
        mouseX = (event.touches[0].clientX + event.touches[1].clientX) / 2.0;          // position inbetween two fingers
        mouseY = (event.touches[0].clientY + event.touches[1].clientY) / 2.0;

        let prevXsep = previousTouches[0].clientX - previousTouches[1].clientX;
        let prevYsep = previousTouches[0].clientY - previousTouches[1].clientY;
        let prevSep = Math.sqrt(prevXsep * prevXsep + prevYsep * prevYsep);

        let curXsep = event.touches[0].clientX - event.touches[1].clientX;
        let curYsep = event.touches[0].clientY - event.touches[1].clientY;
        let curSep = Math.sqrt(curXsep * curXsep + curYsep * curYsep);

        cam.zoomAtMousePos((curSep / prevSep) - 1.0);

        if (wasTwoFingerTouchBefore) {
          cam.changeViewYpos(((mouseX - prevMouseX) / cam.curZoom / canvas.width) * 2.0);
          cam.changeViewYpos(((mouseY - prevMouseY) / cam.curZoom / canvas.width) * 2.0);
        }
        wasTwoFingerTouchBefore = true;
        prevMouseX = mouseX;
        prevMouseY = mouseY;
      }
    }

    previousTouches = event.touches;
  }, {passive : false});


  var lastBpressTime;

  function handlePause()
  {
    if (guiControls.paused) {
      soundSystem?.mute();
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.code == 'ControlLeft') {
      ctrlPressed = true;
    }
    if (event.code == 'ControlRight') {
      // ctrl or cmd on mac
      rightCtrlPressed = true;
    } else if (event.code == 'Space') {
      // space bar
      guiControls.paused = !guiControls.paused;
      handlePause();
    } else if (event.code == 'KeyD') {
      // D
      guiControls.showDrops = !guiControls.showDrops;
    } else if (event.code == 'KeyB') {
      // B: scrolling to change brush size
      bPressed = true;
      if (new Date().getTime() - lastBpressTime < 300 && guiControls.tool != 'TOOL_NONE')
        // double pressed B
        guiControls.wholeWidth = !guiControls.wholeWidth; // toggle whole width brush

      // lastBpressTime = new Date().getTime();
    } else if (event.code == 'KeyF') {
      airplane.toggleCamFollow();
    } else if (event.code == 'KeyV') {
      // V: reset view to full simulation area
      cam.center();
    } else if (event.code == 'KeyG') {
      // G
      guiControls.showGraph = !guiControls.showGraph;
      hideOrShowGraph();
    } else if (event.code == 'Tab') {
      // TAB
      event.preventDefault();
      displayVectorField = !displayVectorField;
    } else if (event.code == 'KeyS') {
      // S: log sample at mouse location
      logSample();
    } else if (event.code == 'KeyZ') {
      zPressed = true;
    } else if (event.code == 'KeyX') {
      // Sample droplets around mouse location
      logDropletsAndToggleFollow();
    } else if (event.code == 'KeyA') {
      if (airplaneMode) {
        airplane.changeDirection();
      } else if (!SETUP_MODE)
        airplane.enableAirplaneMode(event.getModifierState('CapsLock'));
    } else if (event.code == 'CapsLock') {
      if (airplaneMode)
        airplane.setAutopilot(event.getModifierState('CapsLock'));
    } else if (event.code == 'ShiftLeft') {
      airplane.toggleGear();
    } else if (event.key == 1) { // number keys for displaymodes
      guiControls.displayMode = 'DISP_TEMPERATURE';
    } else if (event.key == 2) {
      guiControls.displayMode = 'DISP_WATER';
    } else if (event.key == 3) {
      guiControls.displayMode = 'DISP_REAL';
    } else if (event.key == 4) {
      guiControls.displayMode = 'DISP_HORIVEL';
    } else if (event.key == 5) {
      guiControls.displayMode = 'DISP_VERTVEL';
    } else if (event.key == 6) {
      guiControls.displayMode = 'DISP_IRHEATING';
    } else if (event.key == 7) {
      guiControls.displayMode = 'DISP_IRDOWNTEMP';
    } else if (event.key == 8) {
      guiControls.displayMode = 'DISP_IRUPTEMP';
    } else if (event.key == 9) {
      guiControls.displayMode = 'DISP_PRECIPFEEDBACK_MASS';
    } else if (event.key == 0) {
      guiControls.displayMode = 'DISP_PRECIPFEEDBACK_HEAT';
    } else if (event.code == 'KeyK') {
      guiControls.displayMode = 'DISP_AIRQUALITY';
    } else if (event.code == 'KeyC') {
      guiControls.displayMode = 'DISP_HUMD';
    } else if (event.key == 'ArrowLeft') {
      leftPressed = true; // <
    } else if (event.key == 'ArrowUp') {
      if (!upPressed)
        airplane.onUpPressed();
      upPressed = true;    // ^
    } else if (event.key == 'ArrowRight') {
      rightPressed = true; // >
    } else if (event.key == 'ArrowDown') {
      if (!downPressed)
        airplane.onDownPressed();
      downPressed = true; // v
    } else if (event.key == '=' || event.key == '+') {
      event.preventDefault();
      plusPressed = true; // +
    } else if (event.key == '-') {
      event.preventDefault();
      minusPressed = true; // -
    } else if (event.code == 'Escape') {
      if (guiControls.tool == 'TOOL_NONE' && airplaneMode && confirm('Exit airplane mode?')) {
        airplane.disableAirplaneMode();
      } else {
        guiControls.tool = 'TOOL_NONE';
        guiControls.wholeWidth = false; // flashlight can't be whole width
      }
    } else if (event.code == 'KeyQ') {
      guiControls.tool = 'TOOL_TEMPERATURE';
    } else if (event.code == 'KeyW') {
      guiControls.tool = 'TOOL_WATER';
    } else if (event.code == 'KeyE') {
      guiControls.tool = 'TOOL_WALL_LAND';
    } else if (event.code == 'KeyR') {
      guiControls.tool = 'TOOL_WALL_SEA';
    } else if (event.code == 'KeyT') {
      guiControls.tool = 'TOOL_WALL_FIRE';
    } else if (event.code == 'KeyY') {
      guiControls.tool = 'TOOL_SMOKE';
    } else if (event.code == 'KeyU') {
      guiControls.tool = 'TOOL_WALL_MOIST';
    } else if (event.code == 'KeyI') {
      guiControls.tool = 'TOOL_VEGETATION';
    } else if (event.code == 'KeyO') {
      guiControls.tool = 'TOOL_WALL_SNOW';
    } else if (event.code == 'KeyP') {
      guiControls.tool = 'TOOL_WIND';
    } else if (event.code == 'BracketLeft') {
      guiControls.tool = 'TOOL_WALL_URBAN';
    } else if (event.code == 'BracketRight') {
      guiControls.tool = 'TOOL_WALL_RUNWAY';
    } else if (event.code == 'Backslash') {
      guiControls.tool = 'TOOL_WALL_INDUSTRIAL';
    } else if (event.code == 'KeyN') {
      if (displayWeatherStations) {
        displayWeatherStations = false;
        for (i = 0; i < weatherStations.length; i++) {
          weatherStations[i].setHidden(true);
        }
      } else {
        displayWeatherStations = true;
        for (i = 0; i < weatherStations.length; i++) {
          weatherStations[i].setHidden(false);
        }
      }

      if (guiControls.tool == 'TOOL_STATION') // prevent placing weather stations when not visible
        guiControls.tool = 'TOOL_NONE';
    } else if (event.code == 'KeyM') {
      guiControls.tool = 'TOOL_STATION';
      displayWeatherStations = true;
      for (i = 0; i < weatherStations.length; i++) {
        weatherStations[i].setHidden(false);
      }
    } else if (event.code == 'Period') {
      airplane.setBrakes(true);
    } else if (event.code == 'Slash') {
      airplane.toggleEngine();
    } else if (event.code == 'KeyL') {
      if (new Date() - lastSaveTime > 120000) // more than 120 seconds)
        if (!confirm('Are you sure you want to reload without saving?'))
          return;                             // abort

      // reload simulation
      if (initialRainDrops) { // if loaded from save file
        setupPrecipitationBuffers();
        setupTextures();
        gl.bindVertexArray(fluidVao);
        // iterNum = 0;
        // frameNum = 0;
      }
    } else if (event.code == 'PageUp') {
      adjIterPerFrame(1);
      guiControls.auto_IterPerFrame = false;
    } else if (event.code == 'PageDown') {
      adjIterPerFrame(-1);
      guiControls.auto_IterPerFrame = false;
    } else if (event.code == 'End') {
      guiControls.auto_IterPerFrame = true;
    } else if (event.code == 'Home') {
      guiControls.auto_IterPerFrame = false;
      guiControls.IterPerFrame = 1;
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.code == 'ControlLeft') {
      ctrlPressed = false;
    }
    if (event.code == 'ControlRight') {
      // ctrl or cmd on mac
      rightCtrlPressed = false;
    } else if (event.code == 'KeyB') {
      bPressed = false;
      lastBpressTime = new Date().getTime();
    } else if (event.code == 'KeyZ') {
      zPressed = false;
    } else if (event.key == 'ArrowLeft') {
      leftPressed = false;  // <
    } else if (event.key == 'ArrowUp') {
      upPressed = false;    // ^
    } else if (event.key == 'ArrowRight') {
      rightPressed = false; // >
    } else if (event.key == 'ArrowDown') {
      downPressed = false;  // v
    } else if (event.key == '=' || event.key == '+') {
      plusPressed = false;  // +
    } else if (event.key == '-') {
      minusPressed = false; // -
    } else if (event.code == 'Period') {
      airplane.setBrakes(false);
    }
  });

  await loadingBar.set(9, 'Setting up WebGL');

  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_float_blend');
  gl.getExtension('OES_texture_float_linear');
  gl.getExtension('OES_texture_half_float_linear');

  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);
  // gl.disable(gl.BLEND);
  // gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // load shaders
  var commonSource = await loadSourceFile('shaders/common.glsl');
  var commonDisplaySource = await loadSourceFile('shaders/commonDisplay.glsl');

  const simVertexShader = await loadShader('simShader.vert');
  const dispVertexShader = await loadShader('dispShader.vert');
  const realDispVertexShader = await loadShader('realDispShader.vert');
  const precipDisplayVertexShader = await loadShader('precipDisplayShader.vert');
  const postProcessingVertexShader = await loadShader('postProcessingShader.vert');

  const pressureShader = await loadShader('pressureShader.frag');
  const velocityShader = await loadShader('velocityShader.frag');
  const advectionShader = await loadShader('advectionShader.frag');
  const curlShader = await loadShader('curlShader.frag');
  const vorticityShader = await loadShader('vorticityShader.frag');
  const boundaryShader = await loadShader('boundaryShader.frag');

  const lightingShader = await loadShader('lightingShader.frag');

  const lightningLocationShader = await loadShader('lightningLocationShader.frag');

  const setupShader = await loadShader('setupShader.frag');

  const temperatureDisplayShader = await loadShader('temperatureDisplayShader.frag');
  const airQualityDisplayShader = await loadShader('airQualityDisplayShader.frag');
  const humidityDisplayShader = await loadShader('humidityDisplayShader.frag');
  const precipDisplayShader = await loadShader('precipDisplayShader.frag');
  const universalDisplayShader = await loadShader('universalDisplayShader.frag');
  const skyBackgroundDisplayShader = await loadShader('skyBackgroundDisplayShader.frag');
  const realisticDisplayShader = await loadShader('realisticDisplayShader.frag');
  const IRtempDisplayShader = await loadShader('IRtempDisplayShader.frag');

  const postProcessingShader = await loadShader('postProcessingShader.frag');
  const isolateBrightPartsShader = await loadShader('isolateBrightPartsShader.frag');
  const bloomBlurShader = await loadShader('bloomBlurShader.frag');


  // create programs
  const pressureProgram = createProgram(simVertexShader, pressureShader);
  const velocityProgram = createProgram(simVertexShader, velocityShader);
  const advectionProgram = createProgram(simVertexShader, advectionShader);
  const curlProgram = createProgram(simVertexShader, curlShader);
  const vorticityProgram = createProgram(simVertexShader, vorticityShader);
  const boundaryProgram = createProgram(simVertexShader, boundaryShader);

  const lightingProgram = createProgram(simVertexShader, lightingShader);

  const lightningLocationProgram = createProgram(simVertexShader, lightningLocationShader);

  const setupProgram = createProgram(simVertexShader, setupShader);

  const temperatureDisplayProgram = createProgram(dispVertexShader, temperatureDisplayShader);
  const airQualityDisplayProgram = createProgram(dispVertexShader, airQualityDisplayShader);
  const humidityDisplayProgram = createProgram(dispVertexShader, humidityDisplayShader);
  const precipDisplayProgram = createProgram(precipDisplayVertexShader, precipDisplayShader);
  const universalDisplayProgram = createProgram(dispVertexShader, universalDisplayShader);
  const skyBackgroundDisplayProgram = createProgram(realDispVertexShader, skyBackgroundDisplayShader);
  const realisticDisplayProgram = createProgram(realDispVertexShader, realisticDisplayShader);
  const IRtempDisplayProgram = createProgram(dispVertexShader, IRtempDisplayShader);

  const postProcessingProgram = createProgram(postProcessingVertexShader, postProcessingShader);
  const isolateBrightPartsProgram = createProgram(postProcessingVertexShader, isolateBrightPartsShader);
  const bloomBlurProgram = createProgram(postProcessingVertexShader, bloomBlurShader);
  // const lightBlurProgram = createProgram(postProcessingVertexShader, bloomBlurShader);


  await loadingBar.set(80, 'Setting up textures');

  // // quad that fills the screen, so fragment shader is run for every pixel //
  // X, Y,  U, V  (x4)

  // Don't ask me why, but the * 1.0000001 is nesesary to get exactly round half
  // ( x.5 ) fragcoordinates in the fragmentshaders I figured this out
  // experimentally. It took me days! Without it the linear interpolation would
  // get fucked up because of the tiny offsets
  const fluidQuadVertices = [
    // X, Y,  U, V
    1.0,
    -1.0,
    sim_res_x * 1.0000001,
    0.0,
    -1.0,
    -1.0,
    0.0,
    0.0,
    1.0,
    1.0,
    sim_res_x * 1.0000001,
    sim_res_y * 1.0000001,
    -1.0,
    1.0,
    0.0,
    sim_res_y * 1.0000001,
  ];

  var fluidVao = gl.createVertexArray(); // vertex array object to store
  // bufferData and vertexAttribPointer
  gl.bindVertexArray(fluidVao);
  var fluidVertexBufferObject = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fluidVertexBufferObject);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fluidQuadVertices), gl.STATIC_DRAW);
  var positionAttribLocation = gl.getAttribLocation(pressureProgram,
                                                    'vertPosition'); // 0 these positions are the same for every program,
  // since they all use the same vertex shader
  var texCoordAttribLocation = gl.getAttribLocation(pressureProgram, 'vertTexCoord'); // 1
  gl.enableVertexAttribArray(positionAttribLocation);
  gl.enableVertexAttribArray(texCoordAttribLocation);
  gl.vertexAttribPointer(
    positionAttribLocation,             // Attribute location
    2,                                  // Number of elements per attribute
    gl.FLOAT,                           // Type of elements
    gl.FALSE,
    4 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
    0                                   // Offset from the beginning of a single vertex to this attribute
  );
  gl.vertexAttribPointer(
    texCoordAttribLocation,             // Attribute location
    2,                                  // Number of elements per attribute
    gl.FLOAT,                           // Type of elements
    gl.FALSE,
    4 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
    2 * Float32Array.BYTES_PER_ELEMENT  // Offset from the beginning of a
    // single vertex to this attribute
  );

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);


  const postProcessingQuadVertices = [
    1.0,  // X
    -1.0, // Y
    1.0,  // U
    0.0,  // V
    -1.0,
    -1.0,
    0.0,
    0.0,
    1.0,
    1.0,
    1.0,
    1.0,
    -1.0,
    1.0,
    0.0,
    1.0,
  ];

  var postProcessingVao = gl.createVertexArray(); // vertex array object to store
  // bufferData and vertexAttribPointer
  gl.bindVertexArray(postProcessingVao);
  var postProcessingVertexBufferObject = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, postProcessingVertexBufferObject);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(postProcessingQuadVertices), gl.STATIC_DRAW);
  positionAttribLocation = gl.getAttribLocation(postProcessingProgram,
                                                'vertPosition'); // 0 these positions are the same for every program,
  // since they all use the same vertex shader
  texCoordAttribLocation = gl.getAttribLocation(postProcessingProgram, 'vertTexCoord'); // 1
  gl.enableVertexAttribArray(positionAttribLocation);
  gl.enableVertexAttribArray(texCoordAttribLocation);
  gl.vertexAttribPointer(
    positionAttribLocation,             // Attribute location
    2,                                  // Number of elements per attribute
    gl.FLOAT,                           // Type of elements
    gl.FALSE,
    4 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
    0                                   // Offset from the beginning of a single vertex to this attribute
  );
  gl.vertexAttribPointer(
    texCoordAttribLocation,             // Attribute location
    2,                                  // Number of elements per attribute
    gl.FLOAT,                           // Type of elements
    gl.FALSE,
    4 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
    2 * Float32Array.BYTES_PER_ELEMENT  // Offset from the beginning of a
    // single vertex to this attribute
  );

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);


  // Precipitation setup

  const precipitationVertexShader = await loadShader('precipitationShader.vert');
  const precipitationShader = await loadShader('precipitationShader.frag');
  const precipitationProgram = createProgram(precipitationVertexShader, precipitationShader, [ 'position_out', 'mass_out', 'density_out' ]);

  gl.useProgram(precipitationProgram);

  const dropPositionAttribLocation = 0;
  const massAttribLocation = 1;
  const densityAttribLocation = 2;

  var even = true; // used to switch between precipitation buffers

  const precipitationVao_0 = gl.createVertexArray();
  const precipVertexBuffer_0 = gl.createBuffer();
  const precipitationTF_0 = gl.createTransformFeedback();
  const precipitationVao_1 = gl.createVertexArray();
  const precipVertexBuffer_1 = gl.createBuffer();
  const precipitationTF_1 = gl.createTransformFeedback();


  var rainDrops;

  function initRainDrops()
  {
    rainDrops = [];
    // generate inactive droplets with random values to be used as seeds for random spawning
    for (var i = 0; i < NUM_DROPLETS; i++) {
      // seperate push for each element is fastest
      rainDrops.push(Math.random());         // X
      rainDrops.push(Math.random());         // Y
      rainDrops.push(-10.0 + Math.random()); // water negative to disable
      rainDrops.push(Math.random());         // ice
      rainDrops.push(Math.random());         // density
    }
  }

  function setupPrecipitationBuffers()
  {
    gl.bindVertexArray(precipitationVao_0);

    gl.bindBuffer(gl.ARRAY_BUFFER, precipVertexBuffer_0);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(rainDrops), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(positionAttribLocation);
    gl.enableVertexAttribArray(massAttribLocation);
    gl.enableVertexAttribArray(densityAttribLocation);
    gl.vertexAttribPointer(
      dropPositionAttribLocation,         // Attribute location
      2,                                  // Number of elements per attribute
      gl.FLOAT,                           // Type of elements
      gl.FALSE,
      5 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
      0                                   // Offset from the beginning of a single vertex to this attribute
    );
    gl.vertexAttribPointer(
      massAttribLocation,                 // Attribute location
      2,                                  // Number of elements per attribute
      gl.FLOAT,                           // Type of elements
      gl.FALSE,
      5 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
      2 * Float32Array.BYTES_PER_ELEMENT  // Offset from the beginning of a
      // single vertex to this attribute
    );
    gl.vertexAttribPointer(
      densityAttribLocation,              // Attribute location
      1,                                  // Number of elements per attribute
      gl.FLOAT,                           // Type of elements
      gl.FALSE,
      5 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
      4 * Float32Array.BYTES_PER_ELEMENT  // Offset from the beginning of a
      // single vertex to this attribute
    );

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, precipitationTF_0);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0,
                      precipVertexBuffer_0); // this binds the default (id = 0)
    // TRANSFORM_FEEBACK buffer
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);

    // var precipitationVao_1 = gl.createVertexArray();
    gl.bindVertexArray(precipitationVao_1);

    gl.bindBuffer(gl.ARRAY_BUFFER, precipVertexBuffer_1);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(rainDrops), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(positionAttribLocation);
    gl.enableVertexAttribArray(massAttribLocation);
    gl.enableVertexAttribArray(densityAttribLocation);
    gl.vertexAttribPointer(
      dropPositionAttribLocation,         // Attribute location
      2,                                  // Number of elements per attribute
      gl.FLOAT,                           // Type of elements
      gl.FALSE,
      5 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
      0                                   // Offset from the beginning of a single vertex to this attribute
    );
    gl.vertexAttribPointer(
      massAttribLocation,                 // Attribute location
      2,                                  // Number of elements per attribute
      gl.FLOAT,                           // Type of elements
      gl.FALSE,
      5 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
      2 * Float32Array.BYTES_PER_ELEMENT  // Offset from the beginning of a
      // single vertex to this attribute
    );
    gl.vertexAttribPointer(
      densityAttribLocation,              // Attribute location
      1,                                  // Number of elements per attribute
      gl.FLOAT,                           // Type of elements
      gl.FALSE,
      5 * Float32Array.BYTES_PER_ELEMENT, // Size of an individual vertex
      4 * Float32Array.BYTES_PER_ELEMENT  // Offset from the beginning of a
      // single vertex to this attribute
    );

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, precipitationTF_1);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0,
                      precipVertexBuffer_1); // this binds the default (id = 0)
    // TRANSFORM_FEEBACK buffer
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);

    gl.bindBuffer(gl.ARRAY_BUFFER, null); // buffers are bound via VAO's
    gl.bindVertexArray(fluidVao);         // set screenfilling rect again
  }


  const valsPerDroplet = 5;

  function logDropletsAndToggleFollow()
  {
    if (dropletFollowID >= 0) { // disable follow droplet
      dropletFollowID = -1;
      let dropletInfoCanvas = document.getElementById('dropletInfoCanvas');
      dropletInfoCanvas.style.display = 'none';
      return;
    }

    // log data of all the droplets within the brush
    let tempDroplets = new Float32Array(valsPerDroplet * NUM_DROPLETS);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, even ? precipVertexBuffer_0 : precipVertexBuffer_1); // x, y, water, ice, density
    gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, tempDroplets);

    console.log(' ');
    console.log(' ');
    console.log('DROPLETS:-----------------------------------------');
    console.log(' ');

    let numInBrush = 0;
    let duplicates = 0;

    for (let n = 0; n < NUM_DROPLETS; n++) {
      let i = n * valsPerDroplet;
      let X = tempDroplets[i + 0];
      let Y = tempDroplets[i + 1];
      let x = (X + 1.0) / 2.0;
      let y = (Y + 1.0) / 2.0;
      let water = tempDroplets[i + 2];
      let ice = tempDroplets[i + 3];
      let density = tempDroplets[i + 4];

      let dx = (mouseXinSim - x) * sim_aspect;
      let dy = mouseYinSim - y;
      let dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < guiControls.brushSize / 2.0 / sim_res_y && water >= 0) { // if droplet is within the brush and active
        console.log('n:', n);
        console.log('x:', x);
        console.log('y:', y);
        console.log('water:', water);
        console.log('Ice:', ice);
        console.log('Density:', density);
        console.log(' ');
        numInBrush++;


        if (numInBrush == 1) { // first droplet found
          dropletFollowID = n;
          dropletInfoCanvas.style.display = 'block';
        }
      }
      /*
        // check for duplicates. Very slow!
        if (n < NUM_DROPLETS - 1) {
          for (let d = n + 1; d < NUM_DROPLETS; d++) {
            let j = d * valsPerDroplet;
            if (X == tempDroplets[j + 0] && Y == tempDroplets[j + 1]) {
              duplicates++;
              break;
            }
          }
        }
      */
    }
    console.log(NUM_DROPLETS, 'total droplets. ', numInBrush, 'droplets logged. ', duplicates, ' duplicates found');


    // dropletFollowMode = true;
  }


  var reusedDropletData = new Float32Array(valsPerDroplet); // reused scratch buffer for readDropletData() below, called every frame while following a droplet

  function readDropletData(n)
  {
    let i = n * valsPerDroplet;
    let byteOffset = i * 4; // Convert to byte offset

    let dropletData = reusedDropletData;
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, even ? precipVertexBuffer_0 : precipVertexBuffer_1);
    gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, byteOffset, dropletData, 0, valsPerDroplet);

    dropletData[0] = (dropletData[0] + 1.0) / 2.0;
    dropletData[1] = (dropletData[1] + 1.0) / 2.0;

    // let x = dropletData[0];
    // let y = dropletData[1];
    // let water = dropletData[2];
    // let ice = dropletData[3];
    // let density = dropletData[4];

    // console.log('Droplet ', n);
    // console.log('x:', x);
    // console.log('y:', y);
    // console.log('water:', water);
    // console.log('Ice:', ice);
    // console.log('Density:', density);
    // console.log(' ');

    return dropletData;
  }


  if (initialRainDrops) {
    rainDrops = initialRainDrops;
  } else {
    initRainDrops();
  }

  setupPrecipitationBuffers();


  /*

  TEXTURE DESCRIPTIONS

  base texture: RGBA32F
  [0] = Horizontal velocity                              -1.0 to 1.0
  [1] = Vertical   velocity                              -1.0 to 1.0
  [2] = Pressure                                          >= 0
  [3] = Temperature in air, indicator in wall

  water texture: RGBA32F
  [0] = total water                                        >= 0
  [1] = cloud water                                        >= 0
  [2] = precipitation in air, moisture in surface          >= 0
  [3] = smoke/dust in air, snow in surface                 >= 0 for smoke/dust
  0 to 100 for snow

  wall texture: RGBA8I
  [0] walltype
  [1] manhattan distance to nearest wall                   0 to 127
  [2] height above/below ground. Surface = 0               -127 to 127
  [3] vegetation                                           0 to 127     grass from 0 to 50, trees from 50 to 127

  lighting texture: RGBA32F
  [0] sunlight                                             0 to 1.0
  [1] net heating effect of IR + sun absorbed by smoke
  [2] IR coming down                                       >= 0
  [3] IR going  up                                         >= 0

  */

  const baseTexture_0 = gl.createTexture();
  const baseTexture_1 = gl.createTexture();
  const waterTexture_0 = gl.createTexture();
  const waterTexture_1 = gl.createTexture();
  const wallTexture_0 = gl.createTexture();
  const wallTexture_1 = gl.createTexture();

  const curlTexture = gl.createTexture();
  const vortForceTexture = gl.createTexture();

  const lightTexture_0 = gl.createTexture();
  const lightTexture_1 = gl.createTexture();
  const precipitationFeedbackTexture = gl.createTexture();
  const precipitationDepositionTexture = gl.createTexture();
  const lightningDataTexture = gl.createTexture(); // single pixel texture holding location and timing of current lightning strike

  // Static texures:
  const noiseTexture = gl.createTexture();
  const A380Texture = gl.createTexture();
  const A380_R_Texture = gl.createTexture();
  const A380GearTexture = gl.createTexture();
  const surfaceTextureMap = gl.createTexture();
  const colorScalesTexture = gl.createTexture();

  const lightningTextures = [];
  const numLightningTextures = 10;


  frameBuff_0 = gl.createFramebuffer(); // global for weather stations
  frameBuff_1 = gl.createFramebuffer();  // global for weather stations (station-local STP)

  const curlFrameBuff = gl.createFramebuffer();
  const vortForceFrameBuff = gl.createFramebuffer();

  lightFrameBuff_0 = gl.createFramebuffer();
  const lightFrameBuff_1 = gl.createFramebuffer();
  const precipitationFeedbackFrameBuff = gl.createFramebuffer();
  const lightningDataFrameBuff = gl.createFramebuffer();

  // Set up Textures
  async function setupTextures()
  {
    gl.bindTexture(gl.TEXTURE_2D, baseTexture_0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sim_res_x, sim_res_y, 0, gl.RGBA, gl.FLOAT, initialBaseTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    //	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sim_res_x, sim_res_y, 0, gl.RGBA, gl.FLOAT, initialBaseTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    //	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    gl.bindTexture(gl.TEXTURE_2D, waterTexture_0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sim_res_x, sim_res_y, 0, gl.RGBA, gl.FLOAT, initialWaterTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    //	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    gl.bindTexture(gl.TEXTURE_2D, waterTexture_1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sim_res_x, sim_res_y, 0, gl.RGBA, gl.FLOAT, initialWaterTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    //	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    gl.bindTexture(gl.TEXTURE_2D, wallTexture_0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8I, sim_res_x, sim_res_y, 0, gl.RGBA_INTEGER, gl.BYTE, initialWallTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    //  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    gl.bindTexture(gl.TEXTURE_2D, wallTexture_1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8I, sim_res_x, sim_res_y, 0, gl.RGBA_INTEGER, gl.BYTE, initialWallTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    lastSaveTime = new Date();
  }

  setupTextures();

  createAmbientLightFBOs();

  // Set up Framebuffers


  gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, baseTexture_0, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, waterTexture_0, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, wallTexture_0, 0);


  gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, baseTexture_1, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, waterTexture_1, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, wallTexture_1, 0);


  gl.bindTexture(gl.TEXTURE_2D, curlTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, sim_res_x, sim_res_y, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, curlFrameBuff);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curlTexture,
                          0); // attach the texture as the first color attachment


  gl.bindTexture(gl.TEXTURE_2D, vortForceTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, sim_res_x, sim_res_y, 0, gl.RG, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, vortForceFrameBuff);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, vortForceTexture, 0);

  gl.bindTexture(gl.TEXTURE_2D, lightTexture_0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sim_res_x, sim_res_y, 0, gl.RGBA, gl.FLOAT,
                null);                                               // HALF_FLOAT before, but problems with acuracy
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // LINEAR
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,
                   gl.CLAMP_TO_EDGE); // prevent light from shining trough at bottem or top

  gl.bindFramebuffer(gl.FRAMEBUFFER, lightFrameBuff_0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lightTexture_0, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, emittedLightFBO.texture, 0);


  gl.bindTexture(gl.TEXTURE_2D, lightTexture_1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sim_res_x, sim_res_y, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);    // LINEAR
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); // prevent light from shining trough at bottem or top

  gl.bindFramebuffer(gl.FRAMEBUFFER, lightFrameBuff_1);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lightTexture_1, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, emittedLightFBO.texture, 0);


  gl.bindTexture(gl.TEXTURE_2D, precipitationFeedbackTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sim_res_x, sim_res_y, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindTexture(gl.TEXTURE_2D, precipitationDepositionTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, sim_res_x, sim_res_y, 0, gl.RG, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, precipitationFeedbackFrameBuff);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, precipitationFeedbackTexture, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, precipitationDepositionTexture, 0);

  gl.bindTexture(gl.TEXTURE_2D, lightningDataTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, lightningDataFrameBuff);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lightningDataTexture, 0);

  // load images
  imgElement = await loadImage('resources/img/noise_texture.jpg');

  gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgElement.width, imgElement.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgElement);

  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // gl.texParameteri(
  //     gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,
  //     gl.REPEAT);  // default, so no need to set
  // gl.texParameteri(
  //     gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,
  //     gl.REPEAT);  // default, so no need to set

  imgElement = await loadImage('resources/img/A380.png');

  gl.bindTexture(gl.TEXTURE_2D, A380Texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgElement.width, imgElement.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgElement);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // LINEAR_MIPMAP_LINEAR
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);            // CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);            // REPEAT
                                                                                   // NEAREST_MIPMAP_LINEAR create weird effects

  imgElement = await loadImage('resources/img/A380_R.png');

  gl.bindTexture(gl.TEXTURE_2D, A380_R_Texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgElement.width, imgElement.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgElement);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // LINEAR_MIPMAP_LINEAR
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);            // CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);            // REPEAT

  imgElement = await loadImage('resources/img/A380_gear.png');

  gl.bindTexture(gl.TEXTURE_2D, A380GearTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgElement.width, imgElement.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgElement);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // LINEAR_MIPMAP_LINEAR
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);            // CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);            // REPEAT

  imgElement = await loadImage('resources/img/surfaceTextureMap.png');

  gl.bindTexture(gl.TEXTURE_2D, surfaceTextureMap);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgElement.width, imgElement.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgElement);
  // gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);        // horizontal
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); // vertical


  imgElement = await loadImage('resources/img/ColorScales.png');

  gl.bindTexture(gl.TEXTURE_2D, colorScalesTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgElement.width, imgElement.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgElement);
  // gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); // horizontal
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); // vertical


  function downloadImageData(imgData)
  {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    canvas.width = imgData.width;
    canvas.height = imgData.height
    ctx.putImageData(imgData, 0, 0);
    var dataUrl = canvas.toDataURL('image/png');
    var link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'Lightning_image.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }


  function generateLightningTexture(i, imgData)
  {
    lightningTextures[i] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, lightningTextures[i]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, imgData.width, imgData.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, imgData);
    // gl.generateMipmap(gl.TEXTURE_2D);                                                // optional
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // LINEAR_MIPMAP_LINEAR
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  }


  for (let i = 0; i < numLightningTextures; i++) {
    const lightningGeneratorWorker = new Worker('./lightningGenerator.js');
    lightningGeneratorWorker.onmessage = (imgElement) => {
      // downloadImageData(imgElement.data); // for debugging

      generateLightningTexture(i, imgElement.data);
    };

    lightningGeneratorWorker.postMessage({width : 2500, height : 5000}); // 10000 5000
  }

  await loadingBar.set(90, 'Setting up FBO`s');

  createHdrFBO();

  createBloomFBOs();

  var texelSizeX = 1.0 / sim_res_x;
  var texelSizeY = 1.0 / sim_res_y;

  dryLapse = (guiControls.simHeight * guiControls.dryLapseRate) / 1000.0; // total lapse rate from bottem to top of atmosphere


  // generate sounding data for forcing in sim

  // Rebuilds the realWorldSounding_T/W/Vel uniform arrays from the current global `soundingData` and
  // (re-)uploads them to advectionProgram, always at full real strength -- how much of the wind component
  // actually gets injected into the simulation is controlled purely by the uWindMultiplier uniform in the
  // shader itself (see startWindReset()), not by pre-scaling this data. Called once here during setup, and
  // again later whenever the player picks a different real station's sounding from the in-game station
  // markers or the Sounding Station dropdown (see loadStationForForcing()) -- soundingForcing (the slider
  // right below) continuously relaxes the live simulation toward whatever these currently hold, so
  // re-uploading a new station's profile here changes what the running sim is being pulled toward, without
  // restarting it.
  function updateSoundingForcingUniforms()
  {
    var realWorldSounding_T = new Float32Array(608);   // 152 vec4 = up to sim_res_y + 1 = 607
    var realWorldSounding_W = new Float32Array(608);   // 152 vec4 = up to sim_res_y + 1 = 607
    var realWorldSounding_Vel = new Float32Array(608); // 152 vec4 = up to sim_res_y + 1 = 607

    if (soundingData && soundingData.length > 10) {
      var soundingForSim = rawSoundingToSimSounding(soundingData, guiControls.simHeight, sim_res_y + 1);

      for (var y = 0; y < sim_res_y + 1; y++) {

        let soundingSample = soundingForSim[y];

        realWorldSounding_T[y] = realToPotentialT(CtoK(soundingSample.t), y); // initial temperature profile
        realWorldSounding_W[y] = maxWater(CtoK(soundingSample.td), y);        // initial temperature profile
        realWorldSounding_Vel[y] = soundingSample.vel;
      }
      // console.log(realWorldSounding_T);
      // console.log(realWorldSounding_W);
      // console.log(realWorldSounding_Vel);
    } else {
      console.log('No valid sounding loaded!');
    }

    gl.useProgram(advectionProgram);
    gl.uniform4fv(gl.getUniformLocation(advectionProgram, 'realWorldSounding_Tv'), realWorldSounding_T);
    gl.uniform4fv(gl.getUniformLocation(advectionProgram, 'realWorldSounding_Wv'), realWorldSounding_W);
    gl.uniform4fv(gl.getUniformLocation(advectionProgram, 'realWorldSounding_Velv'), realWorldSounding_Vel);
  }

  // generate Initial temperature profile

  var initial_T = new Float32Array(608); // 152 vec4 = up to sim_res_y + 1 = 607

  for (var y = 0; y < sim_res_y + 1; y++) {
    let altitude = y / (sim_res_y + 1) * guiControls.simHeight;
    var realTemp = Math.max(map_range(altitude, 0, 12000, 15.0, -70.0), -60);

    initial_T[y] = realToPotentialT(CtoK(realTemp), y); // initial temperature profile
  }

  cellHeight = guiControls.simHeight / sim_res_y; // in meters

  // Set constant uniforms
  gl.useProgram(setupProgram);
  gl.uniform2f(gl.getUniformLocation(setupProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform2f(gl.getUniformLocation(setupProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform1f(gl.getUniformLocation(setupProgram, 'dryLapse'), dryLapse);
  gl.uniform1f(gl.getUniformLocation(setupProgram, 'simHeight'), guiControls.simHeight);

  gl.uniform4fv(gl.getUniformLocation(setupProgram, 'initial_Tv'), initial_T);

  gl.useProgram(advectionProgram);
  gl.uniform1i(gl.getUniformLocation(advectionProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(advectionProgram, 'waterTex'), 1);
  gl.uniform1i(gl.getUniformLocation(advectionProgram, 'wallTex'), 2);
  gl.uniform2f(gl.getUniformLocation(advectionProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform2f(gl.getUniformLocation(advectionProgram, 'resolution'), sim_res_x, sim_res_y);
  // gl.uniform1fv(
  // gl.getUniformLocation(advectionProgram, 'initial_T'), initial_T);
  gl.uniform4fv(gl.getUniformLocation(advectionProgram, 'initial_Tv'), initial_T);
  gl.uniform1f(gl.getUniformLocation(advectionProgram, 'dryLapse'), dryLapse);
  gl.uniform1f(gl.getUniformLocation(advectionProgram, 'waterTemperature'),
               CtoK(guiControls.waterTemperature)); // can be changed by GUI input
  gl.uniform1f(gl.getUniformLocation(advectionProgram, 'uWindMultiplier'), windMultiplier); // must never be left at WebGL's implicit 0.0 default, or all wind forcing is silently suppressed from the start

  updateSoundingForcingUniforms();

  gl.useProgram(pressureProgram);
  gl.uniform1i(gl.getUniformLocation(pressureProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(pressureProgram, 'wallTex'), 1);
  gl.uniform2f(gl.getUniformLocation(pressureProgram, 'texelSize'), texelSizeX, texelSizeY);

  gl.useProgram(velocityProgram);
  gl.uniform1i(gl.getUniformLocation(velocityProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(velocityProgram, 'wallTex'), 1);
  gl.uniform2f(gl.getUniformLocation(velocityProgram, 'texelSize'), texelSizeX, texelSizeY);

  // gl.uniform1fv(gl.getUniformLocation(velocityProgram, 'initial_T'), initial_T);
  gl.uniform4fv(gl.getUniformLocation(velocityProgram, 'initial_Tv'), initial_T);

  gl.useProgram(vorticityProgram);
  gl.uniform2f(gl.getUniformLocation(vorticityProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(vorticityProgram, 'curlTex'), 0);

  gl.useProgram(boundaryProgram);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'waterTex'), 1);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'vortForceTex'), 2);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'wallTex'), 3);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'lightTex'), 4);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'precipFeedbackTex'), 5);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'precipDepositionTex'), 6);
  gl.uniform2f(gl.getUniformLocation(boundaryProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(boundaryProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'vorticity'),
               guiControls.vorticity);              // can be changed by GUI input
  gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'waterTemperature'),
               CtoK(guiControls.waterTemperature)); // can be changed by GUI input
  gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'dryLapse'), dryLapse);
  // gl.uniform1fv(gl.getUniformLocation(boundaryProgram, 'initial_T'), initial_T);
  gl.uniform4fv(gl.getUniformLocation(boundaryProgram, 'initial_Tv'), initial_T);
  gl.uniform1i(gl.getUniformLocation(boundaryProgram, 'allowCaves'), guiControls.allowCaves ? 1 : 0);

  gl.useProgram(curlProgram);
  gl.uniform2f(gl.getUniformLocation(curlProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(curlProgram, 'baseTex'), 0);

  gl.useProgram(lightingProgram);
  gl.uniform2f(gl.getUniformLocation(lightingProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(lightingProgram, 'texelSize'), texelSizeX, texelSizeY);

  gl.uniform1i(gl.getUniformLocation(lightingProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(lightingProgram, 'waterTex'), 1);
  gl.uniform1i(gl.getUniformLocation(lightingProgram, 'wallTex'), 2);
  gl.uniform1i(gl.getUniformLocation(lightingProgram, 'lightTex'), 3);
  gl.uniform1f(gl.getUniformLocation(lightingProgram, 'dryLapse'), dryLapse);

  // Display programs:
  gl.useProgram(temperatureDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(temperatureDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(temperatureDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(temperatureDisplayProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(temperatureDisplayProgram, 'wallTex'), 2);
  gl.uniform1i(gl.getUniformLocation(temperatureDisplayProgram, 'colorScalesTex'), 9);
  gl.uniform1f(gl.getUniformLocation(temperatureDisplayProgram, 'dryLapse'), dryLapse);

  gl.useProgram(airQualityDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(airQualityDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(airQualityDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(airQualityDisplayProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(airQualityDisplayProgram, 'waterTex'), 1);
  gl.uniform1i(gl.getUniformLocation(airQualityDisplayProgram, 'wallTex'), 2);
  gl.uniform1i(gl.getUniformLocation(airQualityDisplayProgram, 'colorScalesTex'), 9);
  gl.uniform1f(gl.getUniformLocation(airQualityDisplayProgram, 'dryLapse'), dryLapse);

  gl.useProgram(humidityDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(humidityDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(humidityDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(humidityDisplayProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(humidityDisplayProgram, 'waterTex'), 1);
  gl.uniform1i(gl.getUniformLocation(humidityDisplayProgram, 'wallTex'), 2);
  gl.uniform1i(gl.getUniformLocation(humidityDisplayProgram, 'colorScalesTex'), 9);
  gl.uniform1f(gl.getUniformLocation(humidityDisplayProgram, 'dryLapse'), dryLapse);

  gl.useProgram(precipDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(precipDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(precipDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(precipDisplayProgram, 'waterTex'), 0);
  gl.uniform1i(gl.getUniformLocation(precipDisplayProgram, 'wallTex'), 2);

  gl.useProgram(skyBackgroundDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'simHeight'), guiControls.simHeight);
  gl.uniform1f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'minShadowLight'), minShadowLight);
  gl.uniform1i(gl.getUniformLocation(skyBackgroundDisplayProgram, 'lightTex'), 3);
  gl.uniform1i(gl.getUniformLocation(skyBackgroundDisplayProgram, 'ambientLightTex'), 9);
  gl.uniform1i(gl.getUniformLocation(skyBackgroundDisplayProgram, 'precipFeedbackTex'), 7);
  gl.uniform1i(gl.getUniformLocation(skyBackgroundDisplayProgram, 'planeTex'), 8);
  gl.uniform1i(gl.getUniformLocation(skyBackgroundDisplayProgram, 'planeGearTex'), 10);

  gl.useProgram(universalDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(universalDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(universalDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(universalDisplayProgram, 'anyTex'), 0);
  gl.uniform1i(gl.getUniformLocation(universalDisplayProgram, 'wallTex'), 2);

  gl.useProgram(realisticDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(realisticDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(realisticDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1f(gl.getUniformLocation(realisticDisplayProgram, 'minShadowLight'), minShadowLight);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'waterTex'), 1);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'wallTex'), 2);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'lightTex'), 3);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'noiseTex'), 4);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'surfaceTextureMap'), 5);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'curlTex'), 6);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'lightningTex'), 7);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'lightningDataTex'), 8);
  gl.uniform1i(gl.getUniformLocation(realisticDisplayProgram, 'ambientLightTex'), 9);
  gl.uniform1f(gl.getUniformLocation(realisticDisplayProgram, 'dryLapse'), dryLapse);
  gl.uniform1f(gl.getUniformLocation(realisticDisplayProgram, 'cellHeight'), cellHeight);

  gl.useProgram(precipitationProgram);
  gl.uniform1i(gl.getUniformLocation(precipitationProgram, 'baseTex'), 0);
  gl.uniform1i(gl.getUniformLocation(precipitationProgram, 'waterTex'), 1);
  gl.uniform1i(gl.getUniformLocation(precipitationProgram, 'lightningDataTex'), 2);
  gl.uniform2f(gl.getUniformLocation(precipitationProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(precipitationProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1f(gl.getUniformLocation(precipitationProgram, 'dryLapse'), dryLapse);
  gl.useProgram(IRtempDisplayProgram);
  gl.uniform2f(gl.getUniformLocation(IRtempDisplayProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(IRtempDisplayProgram, 'texelSize'), texelSizeX, texelSizeY);
  gl.uniform1i(gl.getUniformLocation(IRtempDisplayProgram, 'lightTex'), 0);
  gl.uniform1i(gl.getUniformLocation(IRtempDisplayProgram, 'wallTex'), 2);

  gl.useProgram(postProcessingProgram);
  gl.uniform1i(gl.getUniformLocation(postProcessingProgram, 'hdrTex'), 0);
  gl.uniform1i(gl.getUniformLocation(postProcessingProgram, 'bloomTex'), 1);


  gl.useProgram(isolateBrightPartsProgram);
  gl.uniform1i(gl.getUniformLocation(isolateBrightPartsProgram, 'hdrTex'), 0);

  gl.useProgram(lightningLocationProgram);
  gl.uniform1i(gl.getUniformLocation(lightningLocationProgram, 'precipFeedbackTex'), 0);
  gl.uniform2f(gl.getUniformLocation(lightningLocationProgram, 'resolution'), sim_res_x, sim_res_y);
  gl.uniform2f(gl.getUniformLocation(lightningLocationProgram, 'texelSize'), texelSizeX, texelSizeY);


  // console.time('Set uniforms');
  setGuiUniforms(); // all uniforms changed by gui
  // console.timeEnd('Set uniforms')

  gl.bindVertexArray(fluidVao);

  // if no save file was loaded
  // Use setup shader to set initial conditions
  if (initialWallTex == null) {
    gl.viewport(0, 0, sim_res_x, sim_res_y);
    gl.useProgram(setupProgram);
    // Render to both framebuffers
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
    gl.drawBuffers(DRAWBUFFERS_012);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
    gl.drawBuffers(DRAWBUFFERS_012);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }


  if (!SETUP_MODE) {
    startSimulation();
  }

  if (guiControls.sound) {
    soundSystem = new SoundSystem();
  }

  await loadingBar.set(95, 'Loading sounds and generating lightning textures'); // loading complete
  await loadingBar.remove();

  var srcVAO;
  var destVAO;
  var destTF;

  // preload uniform locations for tiny performance gain
  var uniformLocation_boundaryProgram_iterNum = gl.getUniformLocation(boundaryProgram, 'iterNum');
  var uniformLocation_setupProgram_seed = gl.getUniformLocation(setupProgram, 'seed');
  var uniformLocation_setupProgram_heightMult = gl.getUniformLocation(setupProgram, 'heightMult');
  var uniformLocation_advectionProgram_userInputValues = gl.getUniformLocation(advectionProgram, 'userInputValues');
  var uniformLocation_advectionProgram_userInputMove = gl.getUniformLocation(advectionProgram, 'userInputMove');
  var uniformLocation_advectionProgram_wrapHorizontally = gl.getUniformLocation(advectionProgram, 'wrapHorizontally');
  var uniformLocation_advectionProgram_userInputType = gl.getUniformLocation(advectionProgram, 'userInputType');
  var uniformLocation_lightingProgram_IR_rate = gl.getUniformLocation(lightingProgram, 'IR_rate');
  var uniformLocation_precipitationProgram_iterNum = gl.getUniformLocation(precipitationProgram, 'iterNum');
  var uniformLocation_precipitationProgram_currentCAPE = gl.getUniformLocation(precipitationProgram, 'currentCAPE');
  var uniformLocation_precipitationProgram_inactiveDroplets = gl.getUniformLocation(precipitationProgram, 'inactiveDroplets');
  var uniformLocation_lightningLocationProgram_iterNum = gl.getUniformLocation(lightningLocationProgram, 'iterNum');
  var uniformLocation_postProcessingProgram_exposure = gl.getUniformLocation(postProcessingProgram, 'exposure');
  var uniformLocation_bloomBlurProgram_bloomTexture = gl.getUniformLocation(bloomBlurProgram, 'bloomTexture');
  var uniformLocation_bloomBlurProgram_texelSize = gl.getUniformLocation(bloomBlurProgram, 'texelSize');
  var uniformLocation_skyBackgroundDisplayProgram_aspectRatios = gl.getUniformLocation(skyBackgroundDisplayProgram, 'aspectRatios');
  var uniformLocation_skyBackgroundDisplayProgram_view = gl.getUniformLocation(skyBackgroundDisplayProgram, 'view');
  var uniformLocation_skyBackgroundDisplayProgram_Xmult = gl.getUniformLocation(skyBackgroundDisplayProgram, 'Xmult');
  var uniformLocation_skyBackgroundDisplayProgram_iterNum = gl.getUniformLocation(skyBackgroundDisplayProgram, 'iterNum');
  var uniformLocation_skyBackgroundDisplayProgram_screenSize = gl.getUniformLocation(skyBackgroundDisplayProgram, 'screenSize');
  var uniformLocation_realisticDisplayProgram_aspectRatios = gl.getUniformLocation(realisticDisplayProgram, 'aspectRatios');
  var uniformLocation_realisticDisplayProgram_view = gl.getUniformLocation(realisticDisplayProgram, 'view');
  var uniformLocation_realisticDisplayProgram_cursor = gl.getUniformLocation(realisticDisplayProgram, 'cursor');
  var uniformLocation_realisticDisplayProgram_Xmult = gl.getUniformLocation(realisticDisplayProgram, 'Xmult');
  var uniformLocation_realisticDisplayProgram_iterNum = gl.getUniformLocation(realisticDisplayProgram, 'iterNum');
  var uniformLocation_realisticDisplayProgram_displayVectorField = gl.getUniformLocation(realisticDisplayProgram, 'displayVectorField');
  var uniformLocation_precipDisplayProgram_aspectRatios = gl.getUniformLocation(precipDisplayProgram, 'aspectRatios');
  var uniformLocation_precipDisplayProgram_view = gl.getUniformLocation(precipDisplayProgram, 'view');
  var uniformLocation_precipDisplayProgram_showAllDrops = gl.getUniformLocation(precipDisplayProgram, 'showAllDrops');
  var uniformLocation_precipDisplayProgram_waterTex = gl.getUniformLocation(precipDisplayProgram, 'waterTex');
  var uniformLocation_temperatureDisplayProgram_aspectRatios = gl.getUniformLocation(temperatureDisplayProgram, 'aspectRatios');
  var uniformLocation_temperatureDisplayProgram_view = gl.getUniformLocation(temperatureDisplayProgram, 'view');
  var uniformLocation_temperatureDisplayProgram_cursor = gl.getUniformLocation(temperatureDisplayProgram, 'cursor');
  var uniformLocation_temperatureDisplayProgram_Xmult = gl.getUniformLocation(temperatureDisplayProgram, 'Xmult');
  var uniformLocation_temperatureDisplayProgram_displayVectorField = gl.getUniformLocation(temperatureDisplayProgram, 'displayVectorField');
  var uniformLocation_airQualityDisplayProgram_aspectRatios = gl.getUniformLocation(airQualityDisplayProgram, 'aspectRatios');
  var uniformLocation_airQualityDisplayProgram_view = gl.getUniformLocation(airQualityDisplayProgram, 'view');
  var uniformLocation_airQualityDisplayProgram_cursor = gl.getUniformLocation(airQualityDisplayProgram, 'cursor');
  var uniformLocation_airQualityDisplayProgram_Xmult = gl.getUniformLocation(airQualityDisplayProgram, 'Xmult');
  var uniformLocation_humidityDisplayProgram_aspectRatios = gl.getUniformLocation(humidityDisplayProgram, 'aspectRatios');
  var uniformLocation_humidityDisplayProgram_view = gl.getUniformLocation(humidityDisplayProgram, 'view');
  var uniformLocation_humidityDisplayProgram_cursor = gl.getUniformLocation(humidityDisplayProgram, 'cursor');
  var uniformLocation_humidityDisplayProgram_Xmult = gl.getUniformLocation(humidityDisplayProgram, 'Xmult');
  var uniformLocation_IRtempDisplayProgram_aspectRatios = gl.getUniformLocation(IRtempDisplayProgram, 'aspectRatios');
  var uniformLocation_IRtempDisplayProgram_view = gl.getUniformLocation(IRtempDisplayProgram, 'view');
  var uniformLocation_IRtempDisplayProgram_cursor = gl.getUniformLocation(IRtempDisplayProgram, 'cursor');
  var uniformLocation_IRtempDisplayProgram_upOrDown = gl.getUniformLocation(IRtempDisplayProgram, 'upOrDown');
  var uniformLocation_IRtempDisplayProgram_Xmult = gl.getUniformLocation(IRtempDisplayProgram, 'Xmult');
  var uniformLocation_universalDisplayProgram_aspectRatios = gl.getUniformLocation(universalDisplayProgram, 'aspectRatios');
  var uniformLocation_universalDisplayProgram_view = gl.getUniformLocation(universalDisplayProgram, 'view');
  var uniformLocation_universalDisplayProgram_cursor = gl.getUniformLocation(universalDisplayProgram, 'cursor');
  var uniformLocation_universalDisplayProgram_Xmult = gl.getUniformLocation(universalDisplayProgram, 'Xmult');
  var uniformLocation_universalDisplayProgram_quantityIndex = gl.getUniformLocation(universalDisplayProgram, 'quantityIndex');
  var uniformLocation_universalDisplayProgram_dispMultiplier = gl.getUniformLocation(universalDisplayProgram, 'dispMultiplier');

  // Reused readPixels() scratch buffers for the precipitation/lightning sampling inside the per-frame
  // simulation loop below -- both are fully overwritten and consumed synchronously on every use, so
  // allocating one Float32Array(4) per call (potentially every iteration, since the lightning one is
  // gated only by guiControls.sound) was pure avoidable GC pressure on a hot path.
  var reusedPrecipSampleValues = new Float32Array(4);
  var reusedLightningDataValues = new Float32Array(4);

  for (i = 0; i < weatherStations.length; i++) { // initial measurement at weather stations
    weatherStations[i].measure();
  }

  setInterval(calcFps, 1000); // log fps
  requestAnimationFrame(draw);

  function draw()
  { // Runs for every frame
    let camPanSpeed = guiControls.camSpeed;

    if (rightCtrlPressed) {
      camPanSpeed *= 0.2;
    }

    if (!airplaneMode) {
      if (upPressed) {
        // ^
        cam.changeViewYpos(-camPanSpeed / cam.curZoom);
      }
      if (downPressed) {
        // v
        cam.changeViewYpos(camPanSpeed / cam.curZoom);
      }
    }
    if (leftPressed) {
      // <
      cam.changeViewXpos(camPanSpeed / cam.curZoom);
    }
    if (rightPressed) {
      // >
      cam.changeViewXpos(-camPanSpeed / cam.curZoom);
    }
    if (plusPressed) {
      // +
      cam.changeViewZoom(camPanSpeed);
    }
    if (minusPressed) {
      // -
      cam.changeViewZoom(-camPanSpeed);
    }

    cam.move();

    prevMouseXinSim = mouseXinSim;
    prevMouseYinSim = mouseYinSim;

    mouseXinSim = screenToSimX(mouseX);
    mouseYinSim = screenToSimY(mouseY);

    if (SETUP_MODE) {
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, sim_res_x, sim_res_y);
      gl.useProgram(setupProgram);
      gl.uniform1f(uniformLocation_setupProgram_seed, mouseXinSim);
      gl.uniform1f(uniformLocation_setupProgram_heightMult, ((canvas.height - mouseY) / canvas.height) * 2.0);
      // Render to both framebuffers
      gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
      gl.drawBuffers(DRAWBUFFERS_012);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
      gl.drawBuffers(DRAWBUFFERS_012);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      // NOT SETUP MODE:

      // gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(advectionProgram);

      var inputType = -1;
      if (leftMousePressed) {
        if (guiControls.tool == 'TOOL_NONE')
          inputType = 0; // only flashlight on
        else if (guiControls.tool == 'TOOL_TEMPERATURE')
          inputType = 1;
        else if (guiControls.tool == 'TOOL_WATER')
          inputType = 2;
        else if (guiControls.tool == 'TOOL_SMOKE')
          inputType = 3;
        else if (guiControls.tool == 'TOOL_WIND')
          inputType = 4;
        else if (guiControls.tool == 'TOOL_WALL')
          inputType = 10;
        else if (guiControls.tool == 'TOOL_WALL_LAND')
          inputType = 11;
        else if (guiControls.tool == 'TOOL_WALL_SEA')
          inputType = 12;
        else if (guiControls.tool == 'TOOL_WALL_FIRE')
          inputType = 13;
        else if (guiControls.tool == 'TOOL_WALL_URBAN')
          inputType = 14;
        else if (guiControls.tool == 'TOOL_WALL_RUNWAY')
          inputType = 15;
        else if (guiControls.tool == 'TOOL_WALL_INDUSTRIAL')
          inputType = 16;

        // Surface environment modifiers
        else if (guiControls.tool == 'TOOL_WALL_MOIST')
          inputType = 20;
        else if (guiControls.tool == 'TOOL_WALL_SNOW')
          inputType = 21;
        else if (guiControls.tool == 'TOOL_VEGETATION')
          inputType = 22;

        var intensity = guiControls.brushIntensity;

        if (ctrlPressed) {
          intensity *= -1;
        }

        var posXinSim;

        if (guiControls.wholeWidth)
          posXinSim = -1.0;
        else if (guiControls.wrapHorizontally)
          posXinSim = mod(mouseXinSim, 1.0); // wrap mouse position around borders
        else
          posXinSim = clamp(mouseXinSim, 0.0, 1.0);


        let moveX = mouseXinSim - prevMouseXinSim;
        let moveY = mouseYinSim - prevMouseYinSim;

        gl.uniform4f(uniformLocation_advectionProgram_userInputValues, posXinSim, mouseYinSim, intensity, guiControls.brushSize * 0.5);
        gl.uniform2f(uniformLocation_advectionProgram_userInputMove, moveX, moveY);
        gl.uniform1i(uniformLocation_advectionProgram_wrapHorizontally, guiControls.wrapHorizontally);
      }
      gl.uniform1i(uniformLocation_advectionProgram_userInputType, inputType);


      // guiControls.IterPerFrame = 1.0 / timePerIteration * 3600 / 60.0;


      if (!guiControls.paused) { // Simulation part

        let nightAccelerationActive = !airplaneMode && guiControls.dayNightCycle && guiControls.accelerateNight && (guiControls.sunAngle < 0. || guiControls.sunAngle > 180.);

        if (guiControls.dayNightCycle) {
          if (airplaneMode) {
            updateSunlight(1.0 / 3600.0 / 60);                                                                    // increase solar time at real speed: 1/60 seconds per frame
          } else {
            updateSunlight(timePerIteration * guiControls.IterPerFrame * (nightAccelerationActive ? 10.0 : 1.0)); // increase solar time
          }
        }

        gl.useProgram(lightingProgram);
        gl.uniform1f(uniformLocation_lightingProgram_IR_rate, guiControls.IR_rate * (nightAccelerationActive ? 10.0 : 1.0));

        gl.viewport(0, 0, sim_res_x, sim_res_y);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);

        if (!airplaneMode || airplane.hasCrashed() || frameNum % 17 == 0) { // update every 17 frames because 60 * 0.288 secs per iteration = 17.28
          let numIterations = guiControls.IterPerFrame;
          if (airplaneMode)
            numIterations = 1;
          for (var i = 0; i < numIterations; i++) { // Simulation loop
            // calc and apply velocity
            gl.useProgram(velocityProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, baseTexture_0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, wallTexture_0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
            gl.drawBuffers(DRAWBUFFERS_0_NONE_2);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // calc curl
            gl.useProgram(curlProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, curlFrameBuff);
            gl.drawBuffers(DRAWBUFFERS_0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // calculate vorticity
            gl.useProgram(vorticityProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, curlTexture);
            gl.bindFramebuffer(gl.FRAMEBUFFER, vortForceFrameBuff);
            gl.drawBuffers(DRAWBUFFERS_0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // apply vorticity, boundary conditions and user input
            gl.useProgram(boundaryProgram);
            gl.uniform1f(uniformLocation_boundaryProgram_iterNum, iterNum);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, waterTexture_1);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, vortForceTexture);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, wallTexture_1);
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, lightTexture_0);
            gl.activeTexture(gl.TEXTURE5);
            gl.bindTexture(gl.TEXTURE_2D, precipitationFeedbackTexture);
            gl.activeTexture(gl.TEXTURE6);
            gl.bindTexture(gl.TEXTURE_2D, precipitationDepositionTexture);


            gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
            gl.drawBuffers(DRAWBUFFERS_012);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // calc and apply advection
            gl.useProgram(advectionProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, baseTexture_0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, waterTexture_0);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, wallTexture_0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
            gl.drawBuffers(DRAWBUFFERS_012);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // calc and apply pressure
            gl.useProgram(pressureProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, wallTexture_1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
            gl.drawBuffers(DRAWBUFFERS_0_NONE_2);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // calc light
            gl.useProgram(lightingProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, waterTexture_1);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, wallTexture_1);
            gl.activeTexture(gl.TEXTURE3);

            if (even) {
              gl.bindTexture(gl.TEXTURE_2D, lightTexture_0);
              gl.bindFramebuffer(gl.FRAMEBUFFER, lightFrameBuff_1);

              srcVAO = precipitationVao_0;
              destTF = precipitationTF_1;
              destVAO = precipitationVao_1;
            } else {
              gl.bindTexture(gl.TEXTURE_2D, lightTexture_1);
              gl.bindFramebuffer(gl.FRAMEBUFFER, lightFrameBuff_0);

              srcVAO = precipitationVao_1;
              destTF = precipitationTF_0;
              destVAO = precipitationVao_0;
            }
            even = !even;

            gl.drawBuffers(DRAWBUFFERS_01); // calc light
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);


            gl.bindFramebuffer(gl.FRAMEBUFFER, precipitationFeedbackFrameBuff);
            gl.clear(gl.COLOR_BUFFER_BIT);         // clear precipitation feedback

            if (guiControls.enablePrecipitation) { // move precipitation, HUGE PERFORMANCE BOTTLENECK!

              gl.useProgram(precipitationProgram);
              gl.uniform1f(uniformLocation_precipitationProgram_iterNum, iterNum);
              gl.uniform1f(uniformLocation_precipitationProgram_currentCAPE, guiControls.CAPE);
              gl.enable(gl.BLEND);
              gl.blendFunc(gl.ONE, gl.ONE); // add everything together
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
              gl.activeTexture(gl.TEXTURE1);
              gl.bindTexture(gl.TEXTURE_2D, waterTexture_1);
              gl.activeTexture(gl.TEXTURE2);
              gl.bindTexture(gl.TEXTURE_2D, lightningDataTexture);

              gl.bindVertexArray(srcVAO);
              gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, destTF);
              gl.beginTransformFeedback(gl.POINTS);
              gl.drawBuffers(DRAWBUFFERS_01);
              gl.drawArrays(gl.POINTS, 0, NUM_DROPLETS);
              gl.endTransformFeedback();

              // sample to count number of inactive droplets
              if (iterNum % 600 == 0) {
                gl.readBuffer(gl.COLOR_ATTACHMENT0);
                var sampleValues = reusedPrecipSampleValues;
                // console.time('cnt');
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, sampleValues);
                // console.timeEnd('cnt')         // 1 - 100 ms huge variation
                // console.log(sampleValues[0]);  // number of inactive droplets
                guiControls.inactiveDroplets = sampleValues[0];
                // gl.useProgram(precipitationProgram); // already set
                gl.uniform1f(uniformLocation_precipitationProgram_inactiveDroplets, sampleValues[0]);
              }

              gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
              gl.disable(gl.BLEND);
              gl.bindVertexArray(fluidVao); // set screenfilling rect again


              // Extract lightningLocation from precipitationfeedback
              gl.useProgram(lightningLocationProgram);
              gl.uniform1f(uniformLocation_lightningLocationProgram_iterNum, iterNum);

              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, precipitationFeedbackTexture);

              gl.bindFramebuffer(gl.FRAMEBUFFER, lightningDataFrameBuff);
              gl.drawBuffers(DRAWBUFFERS_0);
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

              if (guiControls.sound) {
                gl.readBuffer(gl.COLOR_ATTACHMENT0);
                var lightningDataValues = reusedLightningDataValues;
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, lightningDataValues);
                // console.log('lightningDataValues: ', lightningDataValues[0], lightningDataValues[1], lightningDataValues[2], iterNum, lightningDataValues[3]);

                if (Math.round(lightningDataValues[2]) == iterNum) {
                  soundSystem.soundThunder(lightningDataValues[0], lightningDataValues[1], Math.pow(lightningDataValues[3], 2.0));
                }
              }
            }

            if (displayWeatherStations && iterNum % 208 == 0) { // ~every 60 in game seconds:  0.00008 *3600 * 208 = 59.9
              for (i = 0; i < weatherStations.length; i++) {
                weatherStations[i].measure();
              }
            }
            if (!airplaneMode) {
              iterNum++;
            }
          }
        }

        if (airplaneMode) {
          iterNum++; // make sure iterNum increases every frame for nice lightning
          airplane.takeUserInput();
          airplane.move();
        }

      } // end of simulation part

      if (guiControls.showGraph) {
        soundingGraph.draw(Math.floor(Math.abs(mod(mouseXinSim * sim_res_x, sim_res_x))), Math.floor(mouseYinSim * sim_res_y));
      } else {
        // panel closed: still keep CAPE/STP alive (at the camera's center column) so hail can spawn/sound/render
        updateAtmosStatsForHail((-cam.curXpos + 1) * 0.5 * sim_res_x);
      }

    } // END OF NOT SETUP MODE

    drawTornadoWarning();

    let cursorType = 1.0; // normal circular brush
    if (guiControls.wholeWidth) {
      cursorType = 2.0;   // cursor whole width brush
    } else if (SETUP_MODE || (inputType <= 0 && !bPressed && (guiControls.tool == 'TOOL_NONE' || guiControls.tool == 'TOOL_STATION'))) {
      cursorType = 0;     // cursor off sig
    }

    gl.useProgram(postProcessingProgram);

    if (cursorType != 0 && !sunIsUp) {
      // working at night
      gl.uniform1f(uniformLocation_postProcessingProgram_exposure, 2.0);
    } else {
      gl.uniform1f(uniformLocation_postProcessingProgram_exposure, guiControls.exposure);
    }

    if (inputType == 0) {
      // clicking while tool is set to flashlight(NONE)
      // enable flashlight
      cursorType += 0.55;
    }

    // Follow droplet
    if (dropletFollowID >= 0) {
      let dropletInfo = readDropletData(dropletFollowID);
      cam.setPosition(-dropletInfo[0] * 2.0 + 1.0, -dropletInfo[1] * 2.0 * (sim_res_y / sim_res_x) + (sim_res_y / sim_res_x));

      let dropletInfoCanvas = document.getElementById('dropletInfoCanvas');
      let ctx = dropletInfoCanvas.getContext('2d');

      ctx.clearRect(0, 0, dropletInfoCanvas.width, dropletInfoCanvas.height);
      ctx.fillStyle = '#00000055';
      ctx.fillRect(0, 0, dropletInfoCanvas.width, dropletInfoCanvas.height);

      ctx.fillStyle = '#FF0000';
      ctx.fillRect(0, 0, 2, 2);

      ctx.font = '15px Arial';
      ctx.fillStyle = '#00AAFF';
      ctx.fillText('Water: ' + dropletInfo[2].toFixed(2), 0, 15);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('Ice     : ' + dropletInfo[3].toFixed(2), 0, 30);
      ctx.fillStyle = '#00FF00';
      ctx.fillText('Dens : ' + dropletInfo[4].toFixed(2), 0, 45);
    }

    if (airplaneMode) {
      airplane.display();
    }

    // render to canvas
    gl.useProgram(realisticDisplayProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // null is canvas
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);        // background color
    gl.clear(gl.COLOR_BUFFER_BIT);


    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, wallTexture_1);

    if (guiControls.displayMode == 'DISP_REAL') {

      { //  Abient Light Calculation
        gl.bindVertexArray(postProcessingVao);

        gl.bindFramebuffer(gl.FRAMEBUFFER, ambientLightFBOs[0].frameBuffer);
        gl.viewport(0, 0, ambientLightFBOs[0].width, ambientLightFBOs[0].height);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        let prevFBO = emittedLightFBO; // the previous FBO

        gl.useProgram(bloomBlurProgram);
        gl.uniform1i(uniformLocation_bloomBlurProgram_bloomTexture, 0);

        for (let blurTimes = 0; blurTimes < 2; blurTimes++) { // blur twice for smoother result

          // downsample
          for (let i = 1; i < ambientLightFBOs.length; i++) {
            let destFBO = ambientLightFBOs[i];
            gl.uniform2f(uniformLocation_bloomBlurProgram_texelSize, prevFBO.texelSizeX, prevFBO.texelSizeY);

            gl.viewport(0, 0, destFBO.width, destFBO.height);

            // bind texture
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, prevFBO.texture);

            gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO.frameBuffer);
            // gl.drawBuffers([ gl.BACK ]);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to destFBO

            prevFBO = destFBO;
          }

          // upsample and add
          gl.blendFunc(gl.ONE, gl.ONE); // add to the existing texture in the framebuffer
          gl.enable(gl.BLEND);

          for (let i = ambientLightFBOs.length - 2; i >= 0; i--) {
            let destFBO = ambientLightFBOs[i];

            gl.uniform2f(uniformLocation_bloomBlurProgram_texelSize, prevFBO.texelSizeX, prevFBO.texelSizeY);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, prevFBO.texture);

            gl.viewport(0, 0, destFBO.width, destFBO.height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO.frameBuffer);
            // gl.drawBuffers([ gl.BACK ]);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to destFBO

            prevFBO = destFBO;
          }
          gl.disable(gl.BLEND);
        }
        gl.bindVertexArray(fluidVao);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFBO.frameBuffer); // render to hdr framebuffer
      // gl.viewport(0, 0, sim_res_x, sim_res_y);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.0, 0.0, 0.0, 1.0); // background color
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, waterTexture_1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, wallTexture_1);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, lightTexture_0);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, surfaceTextureMap);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, curlTexture);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, precipitationFeedbackTexture);


      // draw background
      gl.activeTexture(gl.TEXTURE8);
      gl.bindTexture(gl.TEXTURE_2D, airplane.directionIsLeft ? A380Texture : A380_R_Texture); // A380Texture
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, ambientLightFBOs[0].texture);
      gl.activeTexture(gl.TEXTURE10);
      gl.bindTexture(gl.TEXTURE_2D, A380GearTexture);

      gl.useProgram(skyBackgroundDisplayProgram);
      gl.uniform2f(uniformLocation_skyBackgroundDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
      gl.uniform3f(uniformLocation_skyBackgroundDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
      gl.uniform1f(uniformLocation_skyBackgroundDisplayProgram_Xmult, horizontalDisplayMult);
      gl.uniform1f(uniformLocation_skyBackgroundDisplayProgram_iterNum, iterNum);
      gl.uniform2f(uniformLocation_skyBackgroundDisplayProgram_screenSize, gl.drawingBufferWidth, gl.drawingBufferHeight);

      gl.drawBuffers(DRAWBUFFERS_0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to hdrFramebuffer

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);


      // draw clouds and terrain
      gl.useProgram(realisticDisplayProgram);
      gl.uniform2f(uniformLocation_realisticDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
      gl.uniform3f(uniformLocation_realisticDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
      gl.uniform4f(uniformLocation_realisticDisplayProgram_cursor, mouseXinSim, mouseYinSim, guiControls.brushSize * 0.5, cursorType);
      gl.uniform1f(uniformLocation_realisticDisplayProgram_Xmult, horizontalDisplayMult);
      gl.uniform1f(uniformLocation_realisticDisplayProgram_iterNum, iterNum);

      // Don't display vectors when zoomed out because you would just see noise
      if (cam.curZoom / sim_res_x > 0.003) {
        gl.uniform1f(uniformLocation_realisticDisplayProgram_displayVectorField, displayVectorField);
      } else {
        gl.uniform1f(uniformLocation_realisticDisplayProgram_displayVectorField, 0.0);
      }


      let lightningTexNum = Math.floor(iterNum / 400) % numLightningTextures;
      // console.log(lightningTexNum)

      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, lightningTextures[lightningTexNum]);
      gl.activeTexture(gl.TEXTURE8);
      gl.bindTexture(gl.TEXTURE_2D, lightningDataTexture);

      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, ambientLightFBOs[0].texture);


      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to hdr framebuffer

      gl.disable(gl.BLEND);

      // Post processing:

      gl.bindVertexArray(postProcessingVao);


      gl.useProgram(isolateBrightPartsProgram);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdrFBO.texture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFBOs[0].frameBuffer); // brightPartsFrameBuffer
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.0, 0.0, 0.0, 1.0);                            // background color
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.drawBuffers(DRAWBUFFERS_0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // render bright parts to seperate texture


      // BLOOM

      let prevFBO = bloomFBOs[0]; // the previous FBO

      gl.useProgram(bloomBlurProgram);
      gl.uniform1i(uniformLocation_bloomBlurProgram_bloomTexture, 0);


      // downsample
      for (let i = 1; i < bloomFBOs.length; i++) {
        let destFBO = bloomFBOs[i];
        gl.uniform2f(uniformLocation_bloomBlurProgram_texelSize, prevFBO.texelSizeX, prevFBO.texelSizeY);

        gl.viewport(0, 0, destFBO.width, destFBO.height);

        // bind texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prevFBO.texture);

        gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO.frameBuffer);
        // gl.drawBuffers([ gl.BACK ]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to destFBO

        prevFBO = destFBO;
      }

      // upsample and add
      gl.blendFunc(gl.ONE, gl.ONE); // add to the existing texture in the framebuffer
      gl.enable(gl.BLEND);

      for (let i = bloomFBOs.length - 2; i >= 0; i--) {
        let destFBO = bloomFBOs[i];

        gl.uniform2f(uniformLocation_bloomBlurProgram_texelSize, prevFBO.texelSizeX, prevFBO.texelSizeY);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prevFBO.texture);

        gl.viewport(0, 0, destFBO.width, destFBO.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO.frameBuffer);
        // gl.drawBuffers([ gl.BACK ]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to destFBO

        prevFBO = destFBO;
      }

      gl.disable(gl.BLEND);

      gl.useProgram(postProcessingProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdrFBO.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomFBOs[0].texture);

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      if (SETUP_MODE) {
        gl.uniform1f(uniformLocation_postProcessingProgram_exposure, 50.0);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null); // null is canvas
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.0, 0.0, 0.0, 1.0);        // background color
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.drawBuffers(DRAWBUFFERS_BACK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to canvas

      gl.bindVertexArray(fluidVao);

      if (guiControls.showDrops || guiControls.hailEnabled) { // hail always renders as individual particles, regardless of the "show every drop" debug toggle
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        // draw drops over clouds
        // draw precipitation
        gl.useProgram(precipDisplayProgram);
        gl.uniform2f(uniformLocation_precipDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
        gl.uniform3f(uniformLocation_precipDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
        gl.uniform1f(uniformLocation_precipDisplayProgram_showAllDrops, guiControls.showDrops ? 1.0 : 0.0);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, waterTexture_1); // read here so hail can fade/shrink while still inside the cloud
        gl.uniform1i(uniformLocation_precipDisplayProgram_waterTex, 3);
        gl.bindVertexArray(destVAO);
        gl.drawArrays(gl.POINTS, 0, NUM_DROPLETS);
        gl.bindVertexArray(fluidVao); // set screenfilling rect again
        gl.disable(gl.BLEND);
      }


    } else {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, baseTexture_1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, waterTexture_1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, wallTexture_1);
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, colorScalesTexture);

      if (guiControls.displayMode == 'DISP_TEMPERATURE') {
        gl.useProgram(temperatureDisplayProgram);
        gl.uniform2f(uniformLocation_temperatureDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
        gl.uniform3f(uniformLocation_temperatureDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
        gl.uniform4f(uniformLocation_temperatureDisplayProgram_cursor, mouseXinSim, mouseYinSim, guiControls.brushSize * 0.5, cursorType);
        gl.uniform1f(uniformLocation_temperatureDisplayProgram_Xmult, horizontalDisplayMult);


        // Don't display vectors when zoomed out because you would just see
        // noise
        if (cam.curZoom / sim_res_x > 0.003) {
          gl.uniform1f(uniformLocation_temperatureDisplayProgram_displayVectorField, displayVectorField);
        } else {
          gl.uniform1f(uniformLocation_temperatureDisplayProgram_displayVectorField, 0.0);
        }

      } else if (guiControls.displayMode == 'DISP_AIRQUALITY') {
        gl.useProgram(airQualityDisplayProgram);
        gl.uniform2f(uniformLocation_airQualityDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
        gl.uniform3f(uniformLocation_airQualityDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
        gl.uniform4f(uniformLocation_airQualityDisplayProgram_cursor, mouseXinSim, mouseYinSim, guiControls.brushSize * 0.5, cursorType);
        gl.uniform1f(uniformLocation_airQualityDisplayProgram_Xmult, horizontalDisplayMult);

      } else if (guiControls.displayMode == 'DISP_HUMD') {
        gl.useProgram(humidityDisplayProgram);
        gl.uniform2f(uniformLocation_humidityDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
        gl.uniform3f(uniformLocation_humidityDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
        gl.uniform4f(uniformLocation_humidityDisplayProgram_cursor, mouseXinSim, mouseYinSim, guiControls.brushSize * 0.5, cursorType);
        gl.uniform1f(uniformLocation_humidityDisplayProgram_Xmult, horizontalDisplayMult);

      } else if (guiControls.displayMode == 'DISP_IRDOWNTEMP') {
        gl.useProgram(IRtempDisplayProgram);
        gl.uniform2f(uniformLocation_IRtempDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
        gl.uniform3f(uniformLocation_IRtempDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
        gl.uniform4f(uniformLocation_IRtempDisplayProgram_cursor, mouseXinSim, mouseYinSim, guiControls.brushSize * 0.5, cursorType);
        gl.uniform1i(uniformLocation_IRtempDisplayProgram_upOrDown, 0);
        gl.uniform1f(uniformLocation_IRtempDisplayProgram_Xmult, horizontalDisplayMult);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, lightTexture_0);
      } else if (guiControls.displayMode == 'DISP_IRUPTEMP') {
        gl.useProgram(IRtempDisplayProgram);
        gl.uniform2f(uniformLocation_IRtempDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
        gl.uniform3f(uniformLocation_IRtempDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
        gl.uniform4f(uniformLocation_IRtempDisplayProgram_cursor, mouseXinSim, mouseYinSim, guiControls.brushSize * 0.5, cursorType);
        gl.uniform1i(uniformLocation_IRtempDisplayProgram_upOrDown, 1);
        gl.uniform1f(uniformLocation_IRtempDisplayProgram_Xmult, horizontalDisplayMult);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, lightTexture_0);
      } else {
        gl.useProgram(universalDisplayProgram);
        gl.uniform2f(uniformLocation_universalDisplayProgram_aspectRatios, sim_aspect, canvas_aspect);
        gl.uniform3f(uniformLocation_universalDisplayProgram_view, cam.curXpos, cam.curYpos, cam.curZoom);
        gl.uniform4f(uniformLocation_universalDisplayProgram_cursor, mouseXinSim, mouseYinSim, guiControls.brushSize * 0.5, cursorType);
        gl.uniform1f(uniformLocation_universalDisplayProgram_Xmult, horizontalDisplayMult);

        switch (guiControls.displayMode) {
        case 'DISP_HORIVEL':
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 0);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, windDisplayMultiplier); // full color at guiControls.windDisplayKmh
          break;
        case 'DISP_VERTVEL':
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 1);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 10.0); // 20.0
          break;
        case 'DISP_WATER':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, waterTexture_1);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 0);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, -0.06); // negative number so positive amount is blue
          break;
        case 'DISP_IRHEATING':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, lightTexture_0);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 1);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 50000.0);
          break;
        case 'DISP_PRECIPFEEDBACK_MASS':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, precipitationFeedbackTexture);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 0);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 0.3);
          break;
        case 'DISP_PRECIPFEEDBACK_HEAT':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, precipitationFeedbackTexture);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 1);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 500.0);
          break;
        case 'DISP_PRECIPFEEDBACK_VAPOR':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, precipitationFeedbackTexture);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 2);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 500.0);
          break;
        case 'DISP_PRECIPFEEDBACK_RAIN':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, precipitationDepositionTexture);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 0);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 1.0);
          break;
        case 'DISP_PRECIPFEEDBACK_SNOW':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, precipitationDepositionTexture);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 1);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 1.0);
          break;
        case 'DISP_SOIL_MOISTURE':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, waterTexture_0);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 2);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 0.02);
          break;
        case 'DISP_CURL':
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, curlTexture);
          gl.uniform1i(uniformLocation_universalDisplayProgram_quantityIndex, 0);
          gl.uniform1f(uniformLocation_universalDisplayProgram_dispMultiplier, 7.0);
          break;
        }
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // draw to canvas
    }

    if (displayWeatherStations) {
      for (i = 0; i < weatherStations.length; i++) {
        weatherStations[i].updateCanvas(); // update weather stations
      }
    }

    frameNum++;
    requestAnimationFrame(draw);
  }

  //////////////////////////////////////////////////////// functions:

  function hideOrShowGraph()
  {
    if (guiControls.showGraph) {
      soundingGraph.graphCanvas.style.display = 'block';
    } else {
      soundingGraph.graphCanvas.style.display = 'none';
    }
  }

  function pad(num, size)
  {
    num = num.toString();
    while (num.length < size)
      num = '0' + num;
    return num;
  }

  function dateTimeStr()
  {
    var timeStr;
    if (guiControls.twelveHourClock) { // 12 hour clock for Americans
      timeStr = simDateTime.toLocaleString('en-US', {hour12 : true, hour : 'numeric', minute : 'numeric'});
    } else {                           // 24 hour clock
      timeStr = simDateTime.toLocaleString('fr-FR', {hour12 : false, hour : 'numeric', minute : 'numeric'});
    }

    const monthStr = simDateTime.toLocaleString('fr-FR', {month : 'short', day : 'numeric'});
    return timeStr + '&nbsp; ' + monthStr;
  }

  function onUpdateTimeOfDaySlider()
  {
    let minutes = (guiControls.timeOfDay % 1) * 60;
    simDateTime.setHours(guiControls.timeOfDay, minutes);
    updateSunlight();
  }

  function onUpdateMonthSlider()
  {
    let month = guiControls.month - 0.96;
    let date = (month % 1) * 30;
    simDateTime.setMonth(month, date);
    updateSunlight();
  }

  function updateSunlight(deltaT_hours)
  {
    if (deltaT_hours != 'MANUAL_ANGLE') {
      if (deltaT_hours != null) {                                                   // increment time
        simDateTime = new Date(simDateTime.getTime() + deltaT_hours * 3600 * 1000); // convert hours to ms and add to current date
        guiControls.timeOfDay = simDateTime.getHours() + simDateTime.getMinutes() / 60. + simDateTime.getSeconds() / 3600.;
        guiControls.month = simDateTime.getMonth() + 1 + simDateTime.getDate() / 30.5 + simDateTime.getHours() / 720.;
      } else {
        for (i = 0; i < weatherStations.length; i++) {
          weatherStations[i].clearChart();
        }
      }

      let timeOfDayRad = (guiControls.timeOfDay / 24.0) * 2.0 * Math.PI; // convert to radians

      timeOfDayRad -= Math.PI / 2.0;

      let tiltDeg = Math.sin(guiControls.month * 0.5236 - 1.92) * 23.5; // axis tilt
      let t = tiltDeg * degToRad;                                       // axis tilt in radians
      let l = guiControls.latitude * degToRad;                          // latitude

      guiControls.sunAngle = Math.asin(Math.sin(t) * Math.sin(l) + Math.cos(t) * Math.cos(l) * Math.sin(timeOfDayRad)) * radToDeg;

      if (guiControls.latitude - tiltDeg < 0.0) {
        // If sun is to the north, flip angle
        guiControls.sunAngle = 180.0 - guiControls.sunAngle;
      }
    }
    let solarZenithAngleDeg = (guiControls.sunAngle - 90);
    let solarZenithAngle = solarZenithAngleDeg * degToRad; // Solar zenith angle centered around 0. (0 = vertical)
    // Calculations visualized: https://www.desmos.com/calculator/kzr76zj5hq
    if (Math.abs(solarZenithAngle) < 85.0 * degToRad) {
      sunIsUp = true;
    } else {
      sunIsUp = false;
    }
    //		console.log(solarZenithAngle, sunIsUp);
    //	let sunIntensity = guiControls.sunIntensity *
    // Math.pow(Math.max(Math.sin((90.0 - Math.abs(guiControls.sunAngle)) *
    // degToRad) - 0.1, 0.0) * 1.111, 0.4);
    let sunIntensity = guiControls.sunIntensity * Math.pow(Math.max(Math.sin((180.0 - guiControls.sunAngle) * degToRad), 0.0), 0.1) * 1300.0; // max 1300 w/m2 at 12 km
    // console.log('sunIntensity: ', sunIntensity);

    // minShadowLight = clamp(((90 + 10) - Math.abs(solarZenithAngleDeg)) * 0.006, 0.005, 0.040); // decrease until the sun goes 10 deg below the horizon

    minShadowLight = map_range_C(Math.abs(solarZenithAngleDeg), 100.0, 85.0, 0.005, 0.040); // decrease until the sun goes 10 deg below the horizon

    gl.useProgram(boundaryProgram);
    gl.uniform1f(gl.getUniformLocation(boundaryProgram, 'sunAngle'), solarZenithAngle);
    gl.useProgram(lightingProgram);
    gl.uniform1f(gl.getUniformLocation(lightingProgram, 'sunIntensity'), sunIntensity);
    gl.uniform1f(gl.getUniformLocation(lightingProgram, 'sunAngle'), solarZenithAngle);
    gl.useProgram(realisticDisplayProgram);
    gl.uniform1f(gl.getUniformLocation(realisticDisplayProgram, 'sunAngle'), solarZenithAngle);
    gl.uniform1f(gl.getUniformLocation(realisticDisplayProgram, 'minShadowLight'), minShadowLight);
    gl.useProgram(skyBackgroundDisplayProgram);
    gl.uniform1f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'minShadowLight'), minShadowLight);
    gl.uniform1f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'sunAngle'), solarZenithAngle);
    gl.uniform1f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'month'), guiControls.month);
    gl.uniform1f(gl.getUniformLocation(skyBackgroundDisplayProgram, 'skyEffects'), guiControls.skyEffects ? 1.0 : 0.0);

    if (guiControls.dayNightCycle)
      clockEl.innerHTML = dateTimeStr(); // update clock
    else
      clockEl.innerHTML = '';

    if (lastAtmosStats) {
      atmosStatsEl.innerHTML = 'SBCAPE: ' + lastAtmosStats.CAPE.toFixed(0) + ' J/kg &nbsp; STP: ' + lastAtmosStats.STP.toFixed(2);
    }
  }


  async function prepareDownload()
  {
    let prevIterPerFrame = guiControls.IterPerFrame;
    var newFileName = prompt('Please enter a file name. Can not include \'.\'', saveFileName);

    if (newFileName != null) {
      if (newFileName != '' && !newFileName.includes('.')) {
        saveFileName = newFileName;

        gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_0);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        let baseTextureValues = new Float32Array(4 * sim_res_x * sim_res_y);
        gl.readPixels(0, 0, sim_res_x, sim_res_y, gl.RGBA, gl.FLOAT, baseTextureValues);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        let waterTextureValues = new Float32Array(4 * sim_res_x * sim_res_y);
        gl.readPixels(0, 0, sim_res_x, sim_res_y, gl.RGBA, gl.FLOAT, waterTextureValues);
        gl.readBuffer(gl.COLOR_ATTACHMENT2);
        let wallTextureValues = new Int8Array(4 * sim_res_x * sim_res_y);
        gl.readPixels(0, 0, sim_res_x, sim_res_y, gl.RGBA_INTEGER, gl.BYTE, wallTextureValues);

        let precipBufferValues = new ArrayBuffer(rainDrops.length * Float32Array.BYTES_PER_ELEMENT);
        gl.bindBuffer(gl.ARRAY_BUFFER, precipVertexBuffer_0);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(precipBufferValues));
        gl.bindBuffer(gl.ARRAY_BUFFER, null); // unbind again


        let weatherStationsPositions = new Int16Array(weatherStations.length * 2);
        for (i = 0; i < weatherStations.length; i++) {
          weatherStationsPositions[i * 2] = weatherStations[i].getXpos();
          weatherStationsPositions[i * 2 + 1] = weatherStations[i].getYpos();
        }


        let strGuiControls = JSON.stringify(guiControls);

        let saveDataArray = [
          Uint16Array.of(sim_res_x), Uint16Array.of(sim_res_y), baseTextureValues, waterTextureValues, wallTextureValues, precipBufferValues, Uint16Array.of(weatherStations.length),
          weatherStationsPositions, strGuiControls
        ];
        let blob = new Blob(saveDataArray);        // combine everything into a single blob
        let arrBuff = await blob.arrayBuffer();    // turn into array for pako
        let arr = new Uint8Array(arrBuff);
        let compressed = window.pako.deflate(arr); // compress
        let compressedBlob = new Blob([ Uint32Array.of(saveFileVersionID), compressed ], {
          type : 'application/x-binary',
        }); // turn back into blob and add version id in front
        download(saveFileName + '.weathersandbox', compressedBlob);
      } else {
        alert('You didn\'t enter a valid file name!');
      }
    }
    guiControls.IterPerFrame = prevIterPerFrame;
    lastSaveTime = new Date(); // reset timer
  }

  function createProgram(vertexShader, fragmentShader, transform_feedback_varyings)
  {
    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    if (transform_feedback_varyings != null)
      gl.transformFeedbackVaryings(program, transform_feedback_varyings, gl.INTERLEAVED_ATTRIBS);

    gl.linkProgram(program);
    gl.validateProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
      return program; // linked succesfully
    } else {
      throw 'ERROR: ' + gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
    }
  }

  async function loadSourceFile(fileName)
  {
    try {
      var request = new XMLHttpRequest();
      request.open('GET', fileName, false);
      request.send(null);
    } catch (error) {
      await loadingBar.showError('ERROR loading shader files! If you just opened index.html, try again using a local server!');
      throw error;
    }

    if (request.status === 200)
      return request.responseText;
    else if (request.status === 404)
      throw 'File not found: ' + fileName;
    else
      throw 'File loading error' + request.status;
  }

  async function loadShader(nameIn)
  {
    const re = /(?:\.([^.]+))?$/;

    let extension = re.exec(nameIn)[1]; // extract file extension

    let shaderType;
    let type;

    if (extension == 'vert') {
      type = 'vertex';
      shaderType = gl.VERTEX_SHADER;
    } else if (extension == 'frag') {
      type = 'fragment';
      shaderType = gl.FRAGMENT_SHADER;
    } else {
      throw 'Invalid shadertype: ' + extension;
    }

    let filename = 'shaders/' + type + '/' + nameIn;

    var shaderSource = await loadSourceFile(filename);
    if (shaderSource.includes('#include "common.glsl"')) {
      shaderSource = shaderSource.replace('#include "common.glsl"', commonSource);
    }

    if (shaderSource.includes('#include "commonDisplay.glsl"')) {
      shaderSource = shaderSource.replace('#include "commonDisplay.glsl"', commonDisplaySource);
    }

    const shader = gl.createShader(shaderType);
    gl.shaderSource(shader, shaderSource);
    // console.time('compileShader');
    gl.compileShader(shader);
    // console.timeEnd('compileShader')

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      // Compile error
      throw filename + ' COMPILATION ' + gl.getShaderInfoLog(shader);
    }
    return new Promise(async (resolve) => {
      await loadingBar.add(3, 'Loading shader: ' + nameIn);
      resolve(shader);
    });
  }

  function adjIterPerFrame(adj) { guiControls.IterPerFrame = Math.round(clamp(guiControls.IterPerFrame + adj, 1, 50)); }

  function isPageHidden() { return document.hidden || document.msHidden || document.webkitHidden || document.mozHidden; }

  function calcFps()
  {
    if (!isPageHidden()) {
      FPS = frameNum - lastFrameNum;
      lastFrameNum = frameNum;


      if (!guiControls.paused) {
        console.log(FPS + ' FPS   ' + guiControls.IterPerFrame + ' Iterations / frame      ' + FPS * guiControls.IterPerFrame + ' Iterations / second');

        if (guiControls.auto_IterPerFrame && !airplaneMode) {
          const fpsTarget = 60;
          adjIterPerFrame((FPS / fpsTarget - 1.0) * 5.0); // example: ((30 / 60)-1.0) = -0.5

          if (FPS == fpsTarget)
            adjIterPerFrame(1);
        }
      }
      // calculate total amounts of water and smoke for verification of fluid simulation
      /*
            gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuff_1);
            gl.readBuffer(gl.COLOR_ATTACHMENT1); // watertexture
            var waterTextureValues = new Float32Array(sim_res_x * sim_res_y * 4);
            gl.readPixels(0, 0, sim_res_x, sim_res_y, gl.RGBA, gl.FLOAT, waterTextureValues);

            let totalWaterVapor = 0.0;
            let totalCloudWater = 0.0;
            let totalSmoke = 0.0;

            for (let x = 0; x < sim_res_x; x++) {
              for (let y = 0; y < sim_res_y; y++) {
                let cellInd = (x + y * sim_res_x) * 4;
                let vapor = waterTextureValues[cellInd + 0];
                if (vapor < 1000.0) { // ignore wall
                  totalCloudWater += waterTextureValues[cellInd + 1];
                  totalWaterVapor += vapor;

                  totalSmoke += waterTextureValues[cellInd + 3];
                }
              }
            }

            let totalWater = totalWaterVapor + totalCloudWater;
            console.log('Water  Vapor  Cloud  Smoke\n', Math.round(totalWater), Math.round(totalWaterVapor), Math.round(totalCloudWater), Math.round(totalSmoke));
            */
    }
  }
} // end of mainscript