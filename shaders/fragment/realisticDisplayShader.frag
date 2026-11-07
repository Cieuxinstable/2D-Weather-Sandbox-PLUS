#version 300 es
precision highp float;
precision highp sampler2D;
precision highp isampler2D;

in vec2 fragCoord;    // pixel
in vec2 texCoord;     // this normalized

in vec2 texCoordXmY0; // left
in vec2 texCoordX0Ym; // down
in vec2 texCoordXpY0; // right
in vec2 texCoordX0Yp; // up

in vec2 onScreenUV;

uniform sampler2D baseTex;
uniform sampler2D waterTex;
uniform isampler2D wallTex;
uniform sampler2D lightTex;
uniform sampler2D noiseTex;
uniform sampler2D surfaceTextureMap;
uniform sampler2D curlTex;
uniform sampler2D lightningTex;
uniform sampler2D lightningDataTex;

uniform sampler2D ambientLightTex;

uniform vec2 aspectRatios; // [0] Sim       [1] canvas

#define URBAN 0
#define FIRE_FOREST 1
#define SNOW_FOREST 2
#define FOREST 3
#define INDUS 4


uniform vec2 resolution; // sim resolution
uniform vec2 texelSize;

uniform float cellHeight; // in meters

uniform float dryLapse;
uniform float sunAngle;

uniform float minShadowLight;

uniform vec3 view;   // Xpos  Ypos    Zoom
uniform vec4 cursor; // Xpos   Ypos  Size   type

uniform float displayVectorField;

uniform float iterNum;

uniform float newDecor;   // 1 = procedural trees and houses (with storm damage), 0 = original texture strips
uniform float decorScale; // visual size multiplier of trees and houses (1 = real size)
uniform float kmhPerRaw;  // km/h per raw velocity unit, for wind bending

out vec4 fragmentColor;

#include "common.glsl"

#include "commonDisplay.glsl"

vec4 base, water;
ivec4 wall;
float lightIntensity;

vec3 color;
float opacity = 1.0;

vec3 emittedLight = vec3(0.); // pure light, like lightning

float shadowLight;

vec3 onLight; // extra light that lights up objects, just like sunlight and shadowlight


const vec3 bareDrySoilCol = pow(vec3(0.85, 0.60, 0.40), vec3(GAMMA));
const vec3 bareWetSoilCol = pow(vec3(0.5, 0.2, 0.1), vec3(GAMMA));
const vec3 greenGrassCol = pow(vec3(0.0, 0.7, 0.2), vec3(GAMMA));
const vec3 dryGrassCol = pow(vec3(0.843, 0.588, 0.294), vec3(GAMMA));


vec4 surfaceTexture(int index, vec2 pos)
{
#define numTextures 5.;             // number of textures in the map
  const float texRelHeight = 1. / numTextures;
  pos.y = clamp(pos.y, 0.01, 0.99); // make sure position is within the subtexture
  pos /= numTextures;
  pos.y += float(index) * texRelHeight;
  return texture(surfaceTextureMap, pos);
}


vec3 getWallColor(float depth)
{
  vec3 vegetationCol = mix(greenGrassCol, dryGrassCol, max(1.0 - water[SOIL_MOISTURE] * (1. / fullGreenSoilMoisture), 0.)); // green to brown

  vec3 bareSoilCol = mix(bareDrySoilCol, bareWetSoilCol, map_rangeC(water[SOIL_MOISTURE], 0.0, 20.0, 0.0, 1.0));

  vec3 surfCol = mix(bareSoilCol, vegetationCol, min(float(wall[VEGETATION]) / 50., 1.));

  const vec3 rockCol = vec3(0.70);                                 // gray rock

  vec3 color = mix(surfCol, rockCol, clamp(depth * 0.35, 0., 1.)); // * 0.15


  color *= texture(noiseTex, vec2(texCoord.x * resolution.x, texCoord.y * resolution.y) * 0.2).rgb;                                   // add noise texture

  color = mix(color, vec3(1.0), clamp(min(water[SNOW], fullWhiteSnowHeight) / fullWhiteSnowHeight - max(depth * 0.3, 0.), 0.0, 1.0)); // mix in white for snow cover

  return color;
}

const vec2 lightningTexRes = vec2(2500, 5000);
const float lightningTexAspect = lightningTexRes.x / lightningTexRes.y;

float calcLightningTime(float startIterNum)
{
  float lightningTime = iterNum - startIterNum;
  return lightningTime / 5.0; // 30.0    0. to 1. leader stage, 1. + Flash stage
}

float lightningIntensityOverTime(float Tin, vec2 lightningPos, float intensity)
{
  float T0 = Tin - 1.;

  float repeatPeriod = map_range(random2d(lightningPos), 0., 1., 1.5, 3.0);                                            // 2.5
  float numFlashes = floor(map_range(random2d(lightningPos * 2.737250), 0., 1., 1.0, max(intensity - 0.5, 0.) * 2.0)); // 0.4

  float minT = max(T0 - (repeatPeriod * numFlashes), 0.);

  float T = max(mod(T0, repeatPeriod), minT);

  return max((1. / (0.05 + pow(T * 2.0, 3.))) - 0.005, 0.) * pow(intensity, 2.0); // fading out curve
}

vec3 displayLightning(vec2 pos, float lightningTime, float currentLightningIntensity)
{
  vec2 lightningTexCoord = texCoord;

  lightningTexCoord.x -= mod(pos.x, 1.);

  lightningTexCoord.y -= pos.y;

  float scaleMult = 1. / pos.y; // 1.0 means lightning is as tall as the simheight

  lightningTexCoord.x *= scaleMult * aspectRatios[0] / lightningTexAspect;
  lightningTexCoord.y *= -scaleMult;

  lightningTexCoord.x += 0.5;                                                                                               // center lightning bolt

  if (lightningTexCoord.x < 0.01 || lightningTexCoord.x > 1.01 || lightningTexCoord.y < 0.01 || lightningTexCoord.y > 1.01) // prevent edge effect when mipmapping
    return vec3(0);

  float pixVal = texture(lightningTex, lightningTexCoord).r;

  const float branchShowFactor = 2.5;       // 1.5
  const float leaderBrightness = 50000.;    // 200.0
  const float mainBoltBrightness = 100000.; // 100000.

  float brightnessThreshold = 1. - lightningTime * branchShowFactor;
  brightnessThreshold += lightningTexCoord.y * branchShowFactor; // grow from the top to the bottem

  brightnessThreshold = clamp(brightnessThreshold, 0., 1.);

  if (lightningTime > 1.0) { // main bolt
    brightnessThreshold = 0.95;
    currentLightningIntensity *= mainBoltBrightness;
  } else {
    currentLightningIntensity = leaderBrightness;
  }

  pixVal -= brightnessThreshold;

  pixVal = max(pixVal, 0.0);

  pixVal *= currentLightningIntensity;

  const vec3 lightningCol = vec3(0.70, 0.57, 1.0); // 0.584, 0.576, 1.0

  vec3 outputColor = max(pixVal * lightningCol, vec3(0));

  return outputColor;
}


float saturate(float x) { return min(1.0, max(0.0, x)); }
vec3 saturate(vec3 x) { return min(vec3(1., 1., 1.), max(vec3(0., 0., 0.), x)); }


vec3 bump3y(vec3 x, vec3 yoffset)
{
  vec3 y = vec3(1., 1., 1.) - x * x;
  y = saturate(y - yoffset);
  return y;
}
vec3 spectral_zucconi(float w)
{
  // w: [400, 700] wavelenght(nm)
  // x: [0,   1]
  float x = saturate((w - 400.0) / 300.0);
  const vec3 cs = vec3(3.54541723, 2.86670055, 2.29421995);
  const vec3 xs = vec3(0.69548916, 0.49416934, 0.28269708);
  const vec3 ys = vec3(0.02320775, 0.15936245, 0.53520021);
  return bump3y(cs * (x - xs), ys);
}


vec4 getAirColor(vec2 fragCoordIn)
{
  vec2 bndFragCoord = vec2(fragCoordIn.x, clamp(fragCoordIn.y, 0., resolution.y)); // bound y within range
  base = bilerpWallVis(baseTex, wallTex, bndFragCoord);
  wall = texture(wallTex, bndFragCoord * texelSize);                               // texCoord
  water = bilerpWallVis(waterTex, wallTex, bndFragCoord);
  lightIntensity = texture(lightTex, bndFragCoord * texelSize)[0] / standardSunBrightness;

  ivec4 wallX0Ym = texture(wallTex, texCoordX0Ym);

  float realTemp = potentialToRealT(base[TEMPERATURE]);

  bool nightTime = abs(sunAngle) > 85.0 * deg2rad; // false = day time

  shadowLight = minShadowLight;

  // fragmentColor = vec4(vec3(light),1); return; // View light texture for debugging

  float cloudwater = water[CLOUD];

  vec3 cloudCol = vec3(1.0 / (cloudwater * 0.005 + 1.0)); // 0.10 white to black

  float cloudDensity = max(cloudwater * 13.6, 0.0);

  float totalDensity = cloudDensity + water[PRECIPITATION] * 0.8; // visualize precipitation


  // float cloudOpacity = clamp(cloudwater * 4.0, 0.0, 1.0);
  float cloudOpacity = clamp(1.0 - (1.0 / (1. + totalDensity)), 0.0, 1.0);

  const vec3 smokeThinCol = vec3(0.8, 0.51, 0.26);
  const vec3 smokeThickCol = vec3(0., 0., 0.);


  float smokeOpacity = clamp(1. - (1. / (water[SMOKE] + 1.)), 0.0, 1.0);
  float fireIntensity = clamp((smokeOpacity - 0.8) * 25., 0.0, 1.0);

  vec3 fireCol = hsv2rgb(vec3(fireIntensity * 0.008, 0.98, 5.0)) * 1.0; // 1.0, 0.7, 0.0

  vec3 smokeOrFireCol = mix(mix(smokeThinCol, smokeThickCol, smokeOpacity), fireCol, fireIntensity);

  shadowLight += fireIntensity * 2.5;                                                                                 // 1.5

  float opacity = 1. - (1. - smokeOpacity) * (1. - cloudOpacity);                                                     // alpha blending
  vec3 color = (smokeOrFireCol * smokeOpacity / opacity) + (cloudCol * cloudOpacity * (1. - smokeOpacity) / opacity); // color blending


  vec4 lightningData = texture(lightningDataTex, vec2(0.5));
  vec2 lightningPos = lightningData.xy;
  float lightningStartIterNum = lightningData[START_ITERNUM];

  float lightningTime = calcLightningTime(lightningStartIterNum);
  float currentLightningIntensity = lightningIntensityOverTime(lightningTime, lightningPos, lightningData[INTENSITY]);


  if (lightningData[INTENSITY] > 1.0) { // CG
    emittedLight += displayLightning(lightningPos, lightningTime, currentLightningIntensity);
    emittedLight /= 1. + cloudDensity * 100.0;
  }

#define lightningOnLightBrightness 0.004 // 0.002

  vec2 dist = vec2(lightningPos.x - texCoord.x, max((abs(lightningPos.y / 2. - texCoord.y) - 0.1), 0.));
  dist.x *= aspectRatios[0];
  float lightningOnLight = lightningOnLightBrightness / (pow(length(dist), 2.) + 0.03);
  lightningOnLight *= currentLightningIntensity;
  onLight += vec3(lightningOnLight);

  return vec4(color, opacity);
}

float rand(float n) { return fract(sin(n) * 43758.5453123); }

// ===================== Procedural trees and houses =====================
// Drawn per pixel in the few cells just above the ground. Each object sits in a fixed "slot" along x (world
// anchored), with its kind, size and resistance derived from a hash of the slot index. The ground state of
// the column it stands on (type, vegetation, snow, storm damage stored in the surface cell's CLOUD channel by
// the boundary shader) decides what is drawn. Only 3 columns are sampled per pixel, so the cost stays small.

struct Column {
  bool valid;      // false when this row is inside the ground at that column
  float groundTop; // absolute y (cells) of the ground surface
  int type;
  float vegetation;
  float damage;
  float snow;
  float soilMoisture;
};

Column sampleColumn(float colX, float row)
{
  Column c;
  vec2 tc = vec2(colX + 0.5, row + 0.5) * texelSize;
  ivec4 w = texture(wallTex, tc);
  c.valid = w[DISTANCE] != 0 && w[VERT_DISTANCE] >= 1 && w[VERT_DISTANCE] < 10;
  if (!c.valid)
    return c;
  int vd = w[VERT_DISTANCE];
  c.groundTop = row - float(vd - 1);
  vec2 tcS = tc - vec2(0.0, float(vd) * texelSize.y);
  ivec4 ws = texture(wallTex, tcS);
  vec4 wa = texture(waterTex, tcS);
  c.type = ws[TYPE];
  c.vegetation = float(ws[VEGETATION]);
  c.damage = clamp(wa[CLOUD], 0.0, 1.0);
  c.snow = wa[SNOW];
  c.soilMoisture = wa[SOIL_MOISTURE];
  return c;
}

float slotHash(float i, float k) { return fract(sin(i * 127.1 + k * 311.7) * 43758.5453); }

// Signed horizontal offset of a stem at height v (0..h), bent by the wind: quadratic deflection like a cantilever.
float stemLean(float v, float h, float bend) { return bend * h * (v / h) * (v / h); }

// Returns rgb + alpha of the tree covering point (dx, v) in meters relative to the tree base, or alpha 0.
vec4 drawTree(float dx, float v, float h, float kind, float bend, float damage, float seed, float pxM, Column col)
{
  vec3 bark = pow(vec3(0.33, 0.24, 0.16), vec3(GAMMA));
  float n = texture(noiseTex, vec2(dx, v) * 0.08 + seed * 7.3).r; // leafy texture
  vec3 leaf = kind < 0.6 ? mix(vec3(0.07, 0.20, 0.05), vec3(0.16, 0.34, 0.09), n)    // broadleaf
                         : mix(vec3(0.03, 0.12, 0.05), vec3(0.07, 0.20, 0.09), n);   // conifer
  float dry = max(0.5 - col.soilMoisture * (0.5 / fullGreenSoilMoisture), 0.0);
  leaf = mix(leaf, dryGrassCol * 0.6, dry * 0.6);
  float snowCover = clamp(col.snow / fullWhiteSnowHeight, 0.0, 1.0);

  bool conifer = kind >= 0.6;
  bool poplar = kind >= 0.45 && kind < 0.6;

  // Damage stages (per-tree resistance already applied): 0.25 leaves torn, 0.55 branches broken, 0.8 trunk snapped
  bool snapped = damage > 0.8;
  float standH = snapped ? h * (conifer ? 0.55 : 0.35) : h;

  // fallen top lying on the ground, toward a fixed side for this tree
  if (snapped) {
    float dir = seed > 0.5 ? 1.0 : -1.0;
    float along = dx * dir;
    float logLen = h - standH;
    if (along > 0.0 && along < logLen && v < max(h * 0.05, pxM)) {
      float t = along / logLen;
      if (t > 0.55 && !conifer && n > 0.45) return vec4(mix(leaf, bark, 0.5), 1.0); // broken crown on the ground
      return vec4(bark, 1.0);
    }
  }

  float lean = stemLean(min(v, standH), h, bend);
  float u = dx - lean;

  // trunk
  float trunkTop = conifer ? standH : min(standH, h * (poplar ? 0.9 : 0.62));
  float trunkW = max(h * (conifer ? 0.03 : 0.04) * (1.25 - 0.6 * v / h), pxM * 0.7);
  if (v < trunkTop && abs(u) < trunkW * 0.5) {
    if (snapped && v > standH - max(0.4, pxM)) return vec4(pow(vec3(0.85, 0.75, 0.55), vec3(GAMMA)), 1.0); // splintered wood
    return vec4(bark, 1.0);
  }
  if (snapped && !conifer) return vec4(0.0); // broadleaf crown is gone with the trunk

  float leafLoss = clamp((damage - 0.25) / 0.5, 0.0, 1.0);

  if (conifer) {
    float crownBase = h * 0.18;
    if (v < crownBase || v > standH) return vec4(0.0);
    float f = (v - crownBase) / (h - crownBase);
    float halfW = h * 0.2 * (1.0 - f) * (0.72 + 0.28 * fract(v / (h * 0.13))) + pxM * 0.5; // tiered silhouette
    halfW *= 1.0 - leafLoss * 0.35;
    if (abs(u) < halfW && n > leafLoss * 0.55) {
      vec3 c = leaf;
      if (snowCover > 0.0 && fract(v / (h * 0.13)) > 0.75) c = mix(c, vec3(1.0), snowCover); // snow on the tiers
      return vec4(c, 1.0);
    }
    return vec4(0.0);
  }

  // broadleaf / poplar crown: a few lobes with a noisy edge, thinning out as leaves are torn off
  vec2 cr = poplar ? vec2(0.13, 0.36) * h : vec2(0.30, 0.23) * h;
  float cy = poplar ? h * 0.6 : h * 0.68;
  float shrink = 1.0 - leafLoss * 0.45;
  float d = 2.0;
  for (int k = -1; k <= 1; k++) {
    float kx = float(k) * cr.x * 0.55;
    float ky = cy - abs(float(k)) * cr.y * 0.35;
    float lean2 = stemLean(ky, h, bend);
    vec2 r = cr * (k == 0 ? 1.0 : 0.7) * shrink;
    vec2 q = vec2(dx - lean2 - kx, v - ky) / max(r, vec2(pxM));
    d = min(d, length(q));
  }
  if (d < 1.0 - 0.25 * n && n > leafLoss * 0.75) {
    vec3 c = leaf;
    c = mix(c, vec3(0.95), snowCover * smoothstep(0.3, 1.0, v / h) * 0.6);
    return vec4(c, 1.0);
  }
  // bare branches show through when the crown is thinned or broken
  if (leafLoss > 0.0 && d < 1.0) {
    float lean3 = stemLean(v, h, bend);
    float bx = abs(dx - lean3);
    float branch = abs(bx - (v - trunkTop * 0.85) * 0.9);
    if (v > trunkTop * 0.8 && branch < max(h * 0.012, pxM * 0.6) && damage < 0.65) return vec4(bark, 1.0);
  }
  return vec4(0.0);
}

// Returns rgb + alpha of the house covering point (dx, v) in meters relative to its base center; lit = window lit at night.
vec4 drawHouse(float dx, float v, float kind, float damage, float seed, float pxM, Column col, bool night, out bool lit)
{
  lit = false;
  bool longere = kind > 0.6 && kind <= 0.85;
  bool block = kind > 0.85;
  float w = (block ? 14.0 : longere ? 18.0 : 11.0) * decorScale;
  float wallH = (block ? 10.0 : longere ? 4.5 : 5.5) * decorScale;
  float roofH = (block ? 0.8 : 4.0) * decorScale;
  float halfW = w * 0.5;

  vec3 wallCol = pow(block ? vec3(0.80, 0.78, 0.74) : longere ? vec3(0.66, 0.60, 0.50) : vec3(0.88, 0.82, 0.70), vec3(GAMMA));
  vec3 roofCol = pow(block ? vec3(0.40, 0.40, 0.42) : (seed > 0.4 ? vec3(0.58, 0.25, 0.17) : vec3(0.30, 0.32, 0.35)), vec3(GAMMA));
  float snowCover = clamp(col.snow / fullWhiteSnowHeight, 0.0, 1.0);

  if (abs(dx) < halfW && v < wallH) {
    // windows on a 3 m grid, door in the middle of houses
    float gx = fract((dx + halfW) / (3.0 * decorScale));
    float gy = fract(v / (3.0 * decorScale));
    bool door = !block && abs(dx) < 0.6 * decorScale && v < 2.2 * decorScale;
    if (door) return vec4(pow(vec3(0.30, 0.20, 0.13), vec3(GAMMA)), 1.0);
    if (gx > 0.35 && gx < 0.72 && gy > 0.35 && gy < 0.78 && abs(dx) < halfW - 1.0 * decorScale) {
      float wid = floor((dx + halfW) / (3.0 * decorScale)) + floor(v / (3.0 * decorScale)) * 17.0;
      if (night && slotHash(seed * 91.0 + wid, 3.0) > 0.35) { lit = true; return vec4(pow(vec3(1.0, 0.80, 0.45), vec3(GAMMA)), 1.0); }
      return vec4(pow(night ? vec3(0.08, 0.10, 0.14) : vec3(0.36, 0.46, 0.55), vec3(GAMMA)), 1.0);
    }
    return vec4(wallCol, 1.0);
  }
  float rv = v - wallH;
  if (rv >= 0.0 && rv < roofH) {
    float roofHalf = block ? halfW + 0.3 * decorScale : (halfW + 0.6 * decorScale) * (1.0 - rv / roofH);
    if (abs(dx) < max(roofHalf, pxM * 0.5)) {
      float holes = clamp((damage - 0.25) / 0.6, 0.0, 1.0);
      float n = texture(noiseTex, vec2(dx, rv) * 0.35 + seed * 5.1).r;
      if (n < holes * 0.7) return vec4(pow(vec3(0.22, 0.15, 0.10), vec3(GAMMA)), 1.0); // torn-off tiles: rafters show
      if (snowCover > 0.0 && rv > roofH - (block ? roofH : 0.6 * decorScale) - (roofHalf - abs(dx)) * 0.15) return vec4(mix(roofCol, vec3(1.0), snowCover), 1.0);
      return vec4(roofCol, 1.0);
    }
  }
  if (!block && !longere && rv > roofH * 0.3 && rv < roofH * 0.9 && abs(dx - halfW * 0.45) < 0.45 * decorScale) return vec4(pow(vec3(0.45, 0.32, 0.25), vec3(GAMMA)), 1.0); // chimney
  return vec4(0.0);
}

// Trees and houses covering this pixel. Returns alpha 0 when there is nothing here.
// Ground columns (x-2 .. x+2) are read lazily: only when an object standing on them could reach this pixel.
Column decorCols[5];
bool decorHave[5];

Column decorColumn(int ci, float colX, float row)
{
  if (!decorHave[ci]) {
    decorCols[ci] = sampleColumn(colX + float(ci - 2), row);
    decorHave[ci] = true;
  }
  return decorCols[ci];
}

vec4 drawDecor(vec2 frag, bool night, out bool lit, out bool isTree)
{
  lit = false;
  isTree = false;
  float row = floor(frag.y);
  float pxM = fwidth(frag.x) * cellHeight; // meters per screen pixel
  float colX = floor(frag.x);
  for (int k = 0; k < 5; k++) decorHave[k] = false;

  // houses first (in front of trees)
  float houseSp = 24.0 * decorScale / cellHeight;                   // slot spacing in cells
  float houseReach = min(10.0 * decorScale / cellHeight, 2.0);      // max half width of a house, in cells
  float hs0 = floor((frag.x - houseReach) / houseSp - 0.5), hs1 = floor((frag.x + houseReach) / houseSp + 0.5);
  for (int i = 0; i < 12; i++) {
    float s = hs0 + float(i);
    if (s > hs1) break;
    float xc = (s + 0.5 + (slotHash(s, 1.0) - 0.5) * 0.3) * houseSp;
    int ci = int(floor(xc) - colX) + 2;
    if (ci < 0 || ci > 4 || slotHash(s, 2.0) < 0.15) continue;
    Column c = decorColumn(ci, colX, row);
    if (!c.valid || c.type != WALLTYPE_URBAN) continue;
    vec4 hc = drawHouse((frag.x - xc) * cellHeight, (frag.y - c.groundTop) * cellHeight, slotHash(s, 3.0), c.damage * (0.8 + 0.4 * slotHash(s, 4.0)), slotHash(s, 5.0), pxM, c, night, lit);
    if (hc.a > 0.0) return hc;
  }

  // trees
  float windKmh = base.x * kmhPerRaw;
  float treeSp = 8.0 * decorScale / cellHeight;
  float treeReach = min(13.0 * decorScale / cellHeight, 2.0); // max crown radius + bend, in cells
  float ts0 = floor((frag.x - treeReach) / treeSp - 0.5), ts1 = floor((frag.x + treeReach) / treeSp + 0.5);
  for (int i = 0; i < 24; i++) {
    float s = ts0 + float(i);
    if (s > ts1) break;
    float xc = (s + 0.5 + (slotHash(s, 11.0) - 0.5) * 0.8) * treeSp;
    int ci = int(floor(xc) - colX) + 2;
    if (ci < 0 || ci > 4) continue;
    Column c = decorColumn(ci, colX, row);
    if (!c.valid) continue;
    bool land = c.type == WALLTYPE_LAND;
    bool urbanTree = c.type == WALLTYPE_URBAN;
    if (!land && !urbanTree) continue;
    float density = clamp((c.vegetation - 50.0) / 77.0, 0.0, 1.0); // vegetation 50..127 = trees
    if (urbanTree) density *= 0.35;
    if (slotHash(s, 12.0) > density) continue;
    float h = (14.0 + 20.0 * slotHash(s, 13.0)) * (0.6 + 0.4 * density) * decorScale;
    float kind = slotHash(s, 14.0);
    float stiff = kind >= 0.6 ? 0.8 : kind >= 0.45 ? 1.3 : 1.0; // conifers stiffer, poplars more flexible
    float flutter = sin(iterNum * 0.03 + s * 1.7) * 0.03 * min(abs(windKmh) / 40.0, 1.0);
    float bend = clamp(sign(windKmh) * pow(abs(windKmh) / 130.0, 2.0) * 0.45 * stiff + flutter, -0.6, 0.6);
    float resist = 0.75 + 0.5 * slotHash(s, 15.0);
    vec4 tc = drawTree((frag.x - xc) * cellHeight, (frag.y - c.groundTop) * cellHeight, h, kind, bend, c.damage / resist, slotHash(s, 16.0), pxM, c);
    if (tc.a > 0.0) { isTree = true; return tc; }
  }
  return vec4(0.0);
}

void main()
{
  vec2 bndFragCoord = vec2(fragCoord.x, clamp(fragCoord.y, 0., resolution.y)); // bound y within range
  base = bilerpWallVis(baseTex, wallTex, bndFragCoord);
  wall = texture(wallTex, bndFragCoord * texelSize);                           // texCoord
  water = bilerpWallVis(waterTex, wallTex, bndFragCoord);
  lightIntensity = texture(lightTex, bndFragCoord * texelSize)[0] / standardSunBrightness;

  ivec4 wallX0Ym = texture(wallTex, texCoordX0Ym);

  float realTemp = potentialToRealT(base[TEMPERATURE]);

  bool nightTime = abs(sunAngle) > 85.0 * deg2rad; // false = day time

  shadowLight = minShadowLight;

  // fragmentColor = vec4(vec3(light),1); return; // View light texture for debugging

  float cloudwater = water[CLOUD];

  if (texCoord.y < 0.) {                                     // < texelSize.y below simulation area

    float depth = float(-wall[VERT_DISTANCE]) - fragCoord.y; // -1.0?

    color = getWallColor(depth);

    lightIntensity = texture(lightTex, vec2(texCoord.x, texelSize.y))[0] / standardSunBrightness; // sample lowest part of sim area
    lightIntensity *= pow(0.5, -fragCoord.y);                                                     // 0.5 should be same as in lightingshader deeper is darker

  } else if (texCoord.y > 1.0) {                                                                  // above simulation area
    // color = vec3(0); // no need to set
    opacity = 0.0;                  // completely transparent
  } else if (wall[DISTANCE] == 0) { // is wall
                                    // color = getWallColor(texCoord);

    ivec4 wallXmY0 = texture(wallTex, texCoordXmY0);
    ivec4 wallXpY0 = texture(wallTex, texCoordXpY0);

    switch (wall[TYPE]) {
      // case WALLTYPE_INERT:
      //   color = vec3(0, 0, 0);
      //   break;

    case WALLTYPE_RUNWAY:

      if (wall[VERT_DISTANCE] == 0) {
        vec2 modTexCoord = mod(texCoord * resolution, 1.0);

        color = vec3(0.1);
        color *= texture(noiseTex, vec2(texCoord.x * resolution.x, texCoord.y * resolution.y) * 0.2).rgb; // add noise texture

        if (length(modTexCoord - vec2(0.7, 0.97)) < 0.03) {                                               // side lights
          onLight += vec3(1., 0.8, 0.3) * 300.0;
        }

        if (abs(mod(-iterNum - floor(texCoord.x * resolution.x), 150.0)) < 1.0 && length(modTexCoord - vec2(0.2, 0.98)) < 0.02) {
          onLight += vec3(0., 1.0, 0.) * 5000.0;
        }

        break;
      }

    case WALLTYPE_URBAN:
    case WALLTYPE_INDUSTRIAL:
    case WALLTYPE_FIRE:
    case WALLTYPE_LAND:

      // horizontally interpolate depth value
      float interpDepth = mix(mix(float(-wallXmY0[VERT_DISTANCE]), float(-wall[VERT_DISTANCE]), clamp(fract(fragCoord.x) + 0.5, 0.5, 1.)), float(-wallXpY0[VERT_DISTANCE]), clamp(fract(fragCoord.x) - 0.5, 0., 0.5));
      float depth = interpDepth - fract(fragCoord.y); // - 1.0 ?

      color = getWallColor(depth);

      break;
    case WALLTYPE_WATER:

      // Precomputed values (tweak to taste)
      // Frequencies
      const int numWaveComp = 5;
      const float freqs[numWaveComp] = float[numWaveComp](2.3, 3.7, 5.1, 7.6, 21.7);
      // Amplitudes
      const float amps[numWaveComp] = float[numWaveComp](0.05, 0.03, 0.02, 0.015, 0.004);
      // Speeds
      const float speeds[numWaveComp] = float[numWaveComp](0.006, 0.011, 0.018, 0.025, 0.05);
      // Phases (in radians)
      const float phases[numWaveComp] = float[numWaveComp](1.2, 3.9, 0.7, 5.1, 3.1);

      // Sum up the components
      float waveSignalL = 0.0;
      float waveSignalR = 0.0;

      for (int i = 0; i < numWaveComp; i++) {
        waveSignalL += sin(fragCoord.x * freqs[i] + iterNum * speeds[i] + phases[i]) * amps[i];
        waveSignalR += sin(fragCoord.x * freqs[i] - iterNum * speeds[i] + phases[i]) * amps[i];
      }

      vec4 baseX0Yp = texture(baseTex, texCoordX0Yp);
      float windSpeed = baseX0Yp[VX] * 10.;

      // combine based on wind direction
      float waterLevel = 0.8 + waveSignalL * max(-windSpeed, 0.) + waveSignalR * max(windSpeed, 0.);

      if (wall[VERT_DISTANCE] == 0 && fract(fragCoord.y) > waterLevel) { // air
        vec4 airColor = getAirColor(fragCoord + vec2(0., 0.5));

        opacity = airColor.a;
        color = airColor.rgb;
      } else {
        color = vec3(0, 0.5, 1.0); // water
      }

      // draw 45° slopes under water

      float localX = fract(fragCoord.x);
      float localY = fract(fragCoord.y);

      if (wallXmY0[DISTANCE] == 0 && wallXmY0[TYPE] != WALLTYPE_WATER && (fragCoord.y < 1. || wallX0Ym[TYPE] != WALLTYPE_WATER)) { // wall to the left and below
        if (localX + localY < 1.0) {
          opacity = 1.0;
          water = texture(waterTex, texCoord);
          color = getWallColor(float(-wall[VERT_DISTANCE]) - localY);
          shadowLight = minShadowLight;
        }
      }
      if (wallXpY0[DISTANCE] == 0 && wallXpY0[TYPE] != WALLTYPE_WATER && (fragCoord.y < 1. || wallX0Ym[TYPE] != WALLTYPE_WATER)) { // wall to the right and below
        if (localY - localX < 0.0) {
          opacity = 1.0;
          water = texture(waterTex, texCoord);
          color = getWallColor(float(-wall[VERT_DISTANCE]) - localY);
          shadowLight = minShadowLight;
        }
      }

      break;
    }
  } else { // air

    vec4 airColor = getAirColor(fragCoord);

    opacity = airColor.a;
    color = airColor.rgb;


    vec2 rainbowCenter = vec2(0.0, -1.5 + abs(sunAngle) * 0.60);

    float centerDist = length(onScreenUV - rainbowCenter) * 1.3;

    const float cameraHeight = 1.0;

    float angle = atan(centerDist / cameraHeight) * rad2deg;

    float waveLength = map_range(angle, 40.0, 42.0, 400., 700.);

    float rainSnowFactor = map_rangeC(KtoC(realTemp), 0.0, 5.0, 0.0, 1.0); // only rain if above freezing

    vec3 rainbowCol = spectral_zucconi(waveLength) * min(pow(lightIntensity, 2.0) * 1.9, 1.0) * min(water[PRECIPITATION] * 3.0, 1.0) * rainSnowFactor * 0.7;

    emittedLight += rainbowCol;
    opacity = max(opacity - length(rainbowCol), 0.); // remove some white rain to prevent overbrightening and increase color saturation


    if (wall[VERT_DISTANCE] >= 0 && wall[VERT_DISTANCE] < 10) { // near surface
      float localX = fract(fragCoord.x);
      float localY = fract(fragCoord.y);
      // ivec4 wallX0Ym = texture(wallTex, texCoordX0Ym);

#define texAspect 2560. / 4096. // height / width of tree texture
#define maxTreeHeight 40.       // height in meters when vegetation max = 127
#define maxBuildingHeight 400.  // height in meters upto wich the urban texture reaches


      bool decorDrawn = false;
      // tallest object: trees up to 34 m, apartment blocks ~11 m, times decorScale -> skip cells above it
      float decorTopCells = 34.0 * decorScale / cellHeight + 1.0;
      if (newDecor > 0.5 && wall[DISTANCE] != 0 && wall[VERT_DISTANCE] >= 1 && float(wall[VERT_DISTANCE]) <= decorTopCells) {
        bool decorLit, decorTree;
        vec4 dc = drawDecor(fragCoord, nightTime, decorLit, decorTree);
        if (dc.a > 0.0) {
          color = dc.rgb;
          opacity = 1.0;
          shadowLight = decorLit ? 1.0 : minShadowLight; // lit windows glow at night, everything else follows sunlight
          decorDrawn = true;
        }
      }

      if (newDecor > 0.5) {
        // procedural decor replaces the urban skyline and forest strips (industrial keeps its texture)
      } else if (wallX0Ym[TYPE] == WALLTYPE_URBAN) {

        float heightAboveGround = localY + float(wall[VERT_DISTANCE] - 1);

        float urbanTexHeightNorm = maxBuildingHeight / cellHeight; // example: 200 / 40 = 5

        float urbanTexCoordX = mod(fragCoord.x, resolution.x) * texAspect / urbanTexHeightNorm;
        float urbanTexCoordY = heightAboveGround / urbanTexHeightNorm;

        // urbanTexCoordY += map_rangeC(float(wallX0Ym[VEGETATION]), 127., 50., 0., 1.0); // building height

        urbanTexCoordY = 1.0 - urbanTexCoordY;

        vec4 texCol = surfaceTexture(URBAN, vec2(urbanTexCoordX, urbanTexCoordY));
        if (texCol.a > 0.5) { // if not transparent

          if (nightTime) {
            shadowLight = 1.0;                 // city lights
            texCol.rgb *= vec3(1.0, 0.8, 0.5); // yellowish windows
          } else {                             // day time
            texCol.rgb *= vec3(0.8, 0.9, 1.0); // Blueish windows

            if (length(texCol.rgb) < 0.1)
              texCol.rgb = texture(noiseTex, fragCoord * 0.3).rgb * 0.3;
          }
          color = texCol.rgb;
          opacity = texCol.a;
        }
      }
      if (wallX0Ym[TYPE] == WALLTYPE_INDUSTRIAL) {

        float heightAboveGround = localY + float(wall[VERT_DISTANCE] - 1);

        float urbanTexHeightNorm = maxBuildingHeight / cellHeight; // example: 200 / 40 = 5

        float urbanTexCoordX = mod(fragCoord.x, resolution.x) * texAspect / urbanTexHeightNorm;
        float urbanTexCoordY = heightAboveGround / urbanTexHeightNorm;

        // urbanTexCoordY += map_rangeC(float(wallX0Ym[VEGETATION]), 127., 50., 0., 1.0); // building height

        urbanTexCoordY = 1.0 - urbanTexCoordY;

        vec4 texCol = surfaceTexture(INDUS, vec2(urbanTexCoordX, urbanTexCoordY));
        if (texCol.a > 0.5) { // if not transparent

          if (nightTime) {
            shadowLight = 1.0;                 // city lights
            texCol.rgb *= vec3(1.0, 0.8, 0.5); // yellowish windows
          } else {                             // day time
            texCol.rgb *= vec3(0.8, 0.9, 1.0); // Blueish windows

            if (length(texCol.rgb) < 0.1)
              texCol.rgb = texture(noiseTex, fragCoord * 0.3).rgb * 0.3;
          }
          color = texCol.rgb;
          opacity = texCol.a;
        }
      }


      if (wall[VERT_DISTANCE] == 1) {                                                 // 1 above surface
                                                                                      //  if (wallX0Ym[VERT_DISTANCE] == 0) {

        float treeTexHeightNorm = maxTreeHeight / cellHeight;                         // example: 40 / 120 = 0.333

        float treeTexCoordY = localY / treeTexHeightNorm;                             // full height trees

        treeTexCoordY += map_rangeC(float(wallX0Ym[VEGETATION]), 127., 50., 0., 1.0); // apply trees height depending on vegetation

        float treeTexCoordX = fragCoord.x * texAspect / treeTexHeightNorm;            // static scaled trees

        float heightAboveGround = localY / treeTexHeightNorm;

        treeTexCoordX -= base.x * heightAboveGround * 1.00; // 2.5  trees waving with the wind effect

        treeTexCoordX *= 0.72;                              // Trees only go up to 72% of the texture height
        treeTexCoordY *= 0.72;                              // Trees only go up to 72% of the texture height
        treeTexCoordY = 1. - treeTexCoordY;                 // texture is upside down

        vec4 texCol = vec4(0.0);
        if (newDecor > 0.5 && wallX0Ym[TYPE] != WALLTYPE_FIRE) {
          vec4 surfaceWater = texture(waterTex, texCoordX0Ym);
          if (surfaceWater[SNOW] * 0.01 / cellHeight > heightAboveGround && !decorDrawn)
            texCol = vec4(vec3(1.), 1.); // snow layer on the ground
        } else if (wallX0Ym[TYPE] == WALLTYPE_LAND || wallX0Ym[TYPE] == WALLTYPE_URBAN) { // land below
          vec4 surfaceWater = texture(waterTex, texCoordX0Ym);                     // snow on land below
          float snow = surfaceWater[SNOW];
          if (snow * 0.01 / cellHeight > heightAboveGround)
            texCol = vec4(vec3(1.), 1.);                                                                                                                          // show white snow layer above ground
          else {                                                                                                                                                  // display vegetation
            vec4 treeColor = surfaceTexture(FOREST, vec2(treeTexCoordX, treeTexCoordY));
            vec4 vegetationCol = mix(treeColor, vec4(dryGrassCol, 1.), max(0.5 - surfaceWater[SOIL_MOISTURE] * (0.5 / fullGreenSoilMoisture), 0.) * treeColor.a); // green to brown
            texCol = mix(vegetationCol, surfaceTexture(SNOW_FOREST, vec2(treeTexCoordX, treeTexCoordY)), min(snow / fullWhiteSnowHeight, 1.0));
          }
        } else if (wallX0Ym[TYPE] == WALLTYPE_FIRE) {
          texCol = surfaceTexture(FIRE_FOREST, vec2(treeTexCoordX, treeTexCoordY));
        }
        if (texCol.a > 0.5) { // if not transparent
          color = texCol.rgb;

          shadowLight = minShadowLight;        // make sure trees are dark at night

          if (wallX0Ym[TYPE] == WALLTYPE_FIRE) // fire below
            shadowLight = 1.0;

          opacity = 1. - (1. - opacity) * (1. - texCol.a); // alpha blending
        }

        // draw 45° slopes
        ivec4 wallXmY0 = texture(wallTex, texCoordXmY0);
        ivec4 wallXpY0 = texture(wallTex, texCoordXpY0);

        if (wallXmY0[DISTANCE] == 0 && wall[TYPE] != WALLTYPE_WATER) { // wall to the left and below
          if (localX + localY < 1.0) {
            opacity = 1.0;
            water = texture(waterTex, texCoordX0Ym);
            color = getWallColor(localY - 0.6);
            shadowLight = minShadowLight; // fire should not light ground
          }
        }
        if (wallXpY0[DISTANCE] == 0 && wall[TYPE] != WALLTYPE_WATER) { // wall to the right and below
          if (localY - localX < 0.0) {
            opacity = 1.0;
            water = texture(waterTex, texCoordX0Ym);
            color = getWallColor(localY - 0.6);
            shadowLight = minShadowLight; // fire should not light ground
          }
        }
      }
    }
    float arrow = vectorField(base.xy, displayVectorField);

    if (arrow > 0.5) {
      fragmentColor = vec4(vec3(1., 1., 0.), 1.);
      return; // exit shader
    }

    // color.rg += vec2(arrow);
    // color.b -= arrow;
    // opacity += arrow;
    // lightIntensity += arrow;
  }


  float scatering = clamp(map_range(abs(sunAngle), 75. * deg2rad, 90. * deg2rad, 0., 1.), 0., 1.); // how red the sunlight is

  vec3 finalLight = sunColor(scatering) * lightIntensity;


  if (fract(cursor.w) > 0.5) {                                               // enable flashlight
    vec2 vecFromMouse = cursor.xy - texCoord;
    vecFromMouse.x *= texelSize.y / texelSize.x;                             // aspect ratio correction to make it a circle
                                                                             // shadowLight += max(1. / (1.+length(vecFromMouse)*5.0),0.0); // point light
    shadowLight += max(cos(min(length(vecFromMouse) * 5.0, 2.)) * 1.0, 0.0); // smooth flashlight
  }

  vec3 ambientLight = texture(ambientLightTex, texCoord).rgb;

  onLight += ambientLight * pow(1. - clamp(-texCoord.y * 15., 0., 1.), 2.5);


  finalLight += vec3(shadowLight) + onLight;

  opacity += length(emittedLight);
  opacity = clamp(opacity, 0.0, 1.0);
  fragmentColor = vec4(max(color * finalLight, 0.) + emittedLight, opacity);

  drawCursor(cursor, view); // over everything else
}
