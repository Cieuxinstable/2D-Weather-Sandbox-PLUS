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
// anchored), with its kind, size and resistance derived from a hash of the slot index. The ground state of the
// column it stands on decides what is drawn:
//  - land: vegetation 50..127 (set by the Land brush intensity) = tree density, from isolated trees to a closed
//    forest with a second, darker row behind and undergrowth;
//  - urban: vegetation 0..75 (set by the Urban brush intensity) = house density, from hamlet to dense centre;
//  - storm damage, from the boundary shader: strongest sustained gust felt there, |value| 0..1 = 50..200 km/h,
//    sign = direction it blew (which way trees fall). Each species and building has its own thresholds.
// Ground columns are read lazily and cached, so the cost stays small.

struct Column {
  bool valid;      // false when this row is inside the ground at that column
  float groundTop; // absolute y (cells) of the ground surface
  int type;
  float vegetation;
  float gust;      // strongest gust felt here (peak), km/h
  float prevGust;  // peak before the last one: what broke between prevGust and gust is being animated
  float anim;      // 0..1 progress of that animation (1 = finished)
  float fallDir;   // +1 / -1: direction of the peak gust
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
  int packed = int(abs(wa[CLOUD]) * 16777216.0 + 0.5); // see the boundary shader
  c.gust = float(packed >> 16);
  c.prevGust = float((packed >> 8) & 255);
  c.anim = float(packed & 255) / 255.0;
  c.fallDir = wa[CLOUD] < 0.0 ? -1.0 : 1.0;
  c.snow = wa[SNOW];
  c.soilMoisture = wa[SOIL_MOISTURE];
  return c;
}

float slotHash(float i, float k) { return fract(sin(i * 127.1 + k * 311.7) * 43758.5453); }
vec4 hash4(float n) // 4 cheap pseudo-random values in 0..1 (no sin), for the leaf clumps
{
  vec4 p = fract(vec4(n) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.xxyz + p.yzzw) * p.zywx);
}
vec3 lin(vec3 c) { return pow(c, vec3(GAMMA)); }

// Signed horizontal offset of a stem at height v (0..h), bent by the wind: quadratic deflection like a cantilever.
float stemLean(float v, float h, float bend) { return bend * h * (v / h) * (v / h); }

// Species: 0 oak (chêne), 1 pine (pin), 2 poplar (peuplier), 3 birch (bouleau).
// Damage thresholds in km/h: x = leaves (needles) torn, y = branches broken, z = trunk snapped / uprooted.
vec3 speciesThresholds(int sp) { return sp == 0 ? vec3(85., 115., 175.) : sp == 1 ? vec3(140., 105., 140.) : sp == 2 ? vec3(70., 90., 130.) : vec3(70., 95., 165.); }
vec3 speciesLeaf(int sp) { return sp == 0 ? vec3(0.25, 0.42, 0.16) : sp == 1 ? vec3(0.14, 0.31, 0.18) : sp == 2 ? vec3(0.42, 0.56, 0.23) : vec3(0.52, 0.65, 0.28); }
vec4 speciesCrown(int sp) { return sp == 0 ? vec4(0.44, 0.32, 0.62, 8.) : sp == 2 ? vec4(0.16, 0.42, 0.56, 6.) : vec4(0.30, 0.33, 0.62, 7.); } // rx, ry, centre height (share of h), clumps

// Standing (or fallen, already in the tree's own frame) tree at point (dx, v), meters from its base.
// Returns rgb + alpha 0 when nothing. vMin: only parts above that height are drawn (the broken top).
vec4 treeShape(float dx, float v, float h, int sp, float bend, float leafLoss, bool limbs, float seed, float pxM, float shadeMul, Column col, float vMin, float vMax)
{
  if (v < vMin || v > vMax || v < 0.0) return vec4(0.0);
  vec3 bark = sp == 3 ? lin(vec3(0.90, 0.88, 0.83)) : sp == 2 ? lin(vec3(0.54, 0.50, 0.44)) : lin(vec3(0.36, 0.27, 0.19));
  vec3 leaf = lin(speciesLeaf(sp));
  float dry = max(0.5 - col.soilMoisture * (0.5 / fullGreenSoilMoisture), 0.0);
  leaf = mix(leaf, dryGrassCol * 0.6, dry * 0.5);
  float snowCover = clamp(col.snow / fullWhiteSnowHeight, 0.0, 1.0);
  float u = dx - stemLean(v, h, bend);
  float n = 0.5; // leafy texture, fetched only where a crown is hit

  if (sp == 1) { // pine: dense tiers of needles
    float base = h * 0.16;
    float tierH = (h - base) / 7.0;
    if (v > base) {
      float f = (v - base) / (h - base);
      float ft = fract((v - base) / tierH);
      float halfW = h * 0.21 * (1.0 - f) * (0.78 + 0.22 * (1.0 - ft)) * (1.0 - leafLoss * 0.35) + pxM * 0.6;
      if (abs(u) < halfW * 1.04) n = texture(noiseTex, vec2(dx, v) * 0.11 + seed * 7.3).r;
      if (abs(u) < halfW * (0.92 + 0.12 * n)) {
        vec3 c = leaf * mix(0.62, 1.12, smoothstep(0.0, 0.6, ft)) * (0.9 + 0.2 * n); // dark underside of each tier
        if (snowCover > 0.0 && ft > 0.7) c = mix(c, vec3(1.0), snowCover);
        return vec4(c * shadeMul, 1.0);
      }
    }
    float tw = max(h * 0.035 * (1.2 - 0.7 * v / h), pxM * 0.7);
    if (abs(u) < tw * 0.5) return vec4(bark * shadeMul, 1.0);
    return vec4(0.0);
  }

  // broadleaf crown: one lumpy outline (several lobes around the edge) filled with leaf clumps shaded by a noise
  // relief lit from above. Closed: the sky only shows through once the storm tears leaves off.
  vec4 cr = speciesCrown(sp);
  float rx = cr.x * h, ry = cr.y * h, cy = cr.z * h;
  float cu = dx - stemLean(cy, h, bend); // crown is bent as a block (cheap, looks right)
  vec2 e = vec2(cu / rx, (v - cy) / ry);
  float q = length(e);
  if (q < 1.25) {
    float th = atan(e.y, e.x);
    float lobes = sp == 2 ? 3.0 : 5.0;
    float edge = 1.0 + 0.11 * sin(lobes * th + seed * 6.3) + 0.07 * sin((lobes + 4.0) * th + seed * 11.1) - leafLoss * 0.3;
    if (q < edge + 0.05) {
      float clump = (sp == 2 ? 0.10 : 0.16) * h;                              // size of a leaf clump, m
      vec2 pc = vec2(dx, v) / clump * 0.06 + seed * 3.7;
      float b0 = texture(noiseTex, pc).r;
      float b1 = texture(noiseTex, pc + vec2(0.0, 0.02)).r;                    // relief: clump tops catch the light
      n = b0;
      if (q < edge - 0.06 * b0 && b0 > leafLoss * 0.9) {
        float light = 0.78 + 1.6 * (b1 - b0) + 0.22 * e.y;
        light *= mix(0.75, 1.0, smoothstep(-1.0, 0.3, e.y));                   // crown base in shadow
        vec3 c = leaf * clamp(light, 0.5, 1.25) * (0.92 + 0.16 * b0);
        c = mix(c, vec3(0.95), snowCover * smoothstep(0.1, 0.8, e.y) * 0.6);
        return vec4(c * shadeMul, 1.0);
      }
    }
  }
  // trunk, and broken limbs that show once the crown is torn
  float trunkTop = h * (sp == 2 ? 0.5 : 0.55);
  float tw = max(h * (sp == 0 ? 0.055 : 0.04) * (1.25 - 0.6 * v / h), pxM * 0.7);
  if (v < trunkTop && abs(u) < tw * 0.5) {
    if (sp == 3 && fract(v * 0.6 + seed * 3.0) < 0.12 && abs(u) < tw * 0.3) return vec4(lin(vec3(0.15)) * shadeMul, 1.0); // birch marks
    return vec4(bark * shadeMul, 1.0);
  }
  if (limbs && v > trunkTop * 0.9 && v < h * 0.85) {
    float bx = abs(dx - stemLean(v, h, bend));
    if (abs(bx - (v - trunkTop * 0.9) * 0.8) < max(h * 0.014, pxM * 0.6)) return vec4(bark * shadeMul, 1.0);
  }
  return vec4(0.0);
}

// One tree at (dx, v) with its storm stage. Fallen parts are drawn by rotating the point into the tree's frame.
vec4 drawTree(float dx, float v, float h, int sp, float bend, float resist, float seed, float pxM, float shadeMul, Column col)
{
  vec3 thr = speciesThresholds(sp) * resist;
  float g = col.gust;
  float leafLoss = g > thr.y ? 0.55 : g > thr.x ? 0.28 : 0.0;
  bool limbs = g > thr.y;
  if (g <= thr.z)
    return treeShape(dx, v, h, sp, bend, leafLoss, limbs, seed, pxM, shadeMul, col, 0.0, 1e9);

  // felled: oak, pine and poplar snap (pine near the top), birch is uprooted
  bool uproot = sp == 3;
  float pivot = uproot ? 0.0 : h * (sp == 1 ? 0.6 : 0.35);
  vec4 cr = speciesCrown(sp);
  float cyH = sp == 1 ? h * 0.75 : cr.z * h, crR = sp == 1 ? h * 0.08 : cr.y * h * 0.85;
  float arm = cyH - pivot;
  float cA = (crR - pivot) / max(arm, 0.01);
  float A = cA <= -1.0 ? 1.62 : cA >= 1.0 ? 0.2 : min(1.62, acos(cA)); // stops when the crown rests on the ground
  float drop = uproot ? 0.0 : max(0.0, sp == 1 ? pivot - h * 0.12 : pivot + arm * cos(A) - crR);
  float dir = col.fallDir;
  // falling animation: it broke during the last peak if its threshold is above the previous one
  float prog = col.prevGust >= thr.z ? 1.0 : col.anim;
  float fallP = min(1.0, prog / 0.75);
  A *= fallP * fallP;                       // accelerates as it goes over
  drop *= smoothstep(0.75, 1.0, prog);      // then the broken top slides off the stump

  // standing stump (snapped trees), splintered at the top
  if (!uproot) {
    float tw = max(h * (sp == 0 ? 0.055 : 0.04) * 1.15, pxM * 0.7);
    if (v < pivot && abs(dx) < tw * 0.5) {
      vec3 c = v > pivot - max(0.4, pxM) ? lin(vec3(0.85, 0.75, 0.55)) : (sp == 2 ? lin(vec3(0.54, 0.50, 0.44)) : lin(vec3(0.36, 0.27, 0.19)));
      return vec4(c * shadeMul, 1.0);
    }
  } else if (v < h * 0.07 && length(vec2(dx / (h * 0.16), v / (h * 0.07))) < 1.0) {
    return vec4(lin(vec3(0.29, 0.23, 0.16)) * shadeMul, 1.0); // root plate torn out of the ground
  }
  // the fallen part: rotate the point back into the tree's upright frame
  vec2 p = vec2(dx, v + drop) - vec2(0.0, pivot);
  float ang = A * dir;
  vec2 q = vec2(cos(ang) * p.x - sin(ang) * p.y, sin(ang) * p.x + cos(ang) * p.y) + vec2(0.0, pivot);
  return treeShape(q.x, q.y, h, sp, 0.0, 0.55, false, seed, pxM, shadeMul, col, pivot, 1e9);
}

// Returns rgb + alpha of the house covering point (dx, v) in meters relative to its base center; lit = window lit at night.
// kind: pavillon, longère, chalet or small block. gust: strongest gust felt, km/h; resist: per-building factor.
vec4 drawHouse(float dx, float v, float kind, float gust, float resist, float seed, float pxM, Column col, bool night, out bool lit)
{
  lit = false;
  bool town = kind < 0.0; // narrow town house (2-3 floors), dense centres
  bool longere = kind > 0.55 && kind <= 0.72;
  bool chalet = kind > 0.72 && kind <= 0.88;
  bool block = kind > 0.88;
  float w = (town ? 8.0 : block ? 14.0 : longere ? 18.0 : chalet ? 10.0 : 11.0) * decorScale;
  float wallH = (town ? 6.0 + 3.0 * step(0.5, seed) : block ? 10.0 : longere ? 4.5 : chalet ? 4.0 : 5.5) * decorScale;
  float roofH = (town ? 3.2 : block ? 0.8 : chalet ? 4.5 : 4.0) * decorScale;
  float halfW = w * 0.5;

  vec3 wallCol = lin(town ? mix(vec3(0.86, 0.80, 0.68), vec3(0.74, 0.62, 0.52), fract(seed * 7.7)) : block ? vec3(0.80, 0.78, 0.74) : longere ? vec3(0.66, 0.60, 0.50) : chalet ? vec3(0.60, 0.42, 0.26) : vec3(0.88, 0.82, 0.70));
  vec3 roofCol = lin(block ? vec3(0.40, 0.40, 0.42) : chalet ? vec3(0.24, 0.23, 0.22) : (seed > 0.4 ? vec3(0.58, 0.25, 0.17) : vec3(0.30, 0.32, 0.35)));
  float snowCover = clamp(col.snow / fullWhiteSnowHeight, 0.0, 1.0);

  // damage stages: tiles torn off (100 km/h), roof ripped open (140), roof torn off (185)
  float holes = gust > 140.0 * resist ? 0.55 : gust > 100.0 * resist ? 0.22 : 0.0;
  bool roofGone = gust > 185.0 * resist;

  if (abs(dx) < halfW && v < wallH) {
    // windows on a 3 m grid, door in the middle of houses
    float gx = fract((dx + halfW) / (3.0 * decorScale));
    float gy = fract(v / (3.0 * decorScale));
    bool door = !block && abs(dx) < 0.6 * decorScale && v < 2.2 * decorScale;
    if (door) return vec4(lin(vec3(0.30, 0.20, 0.13)), 1.0);
    if (gx > 0.35 && gx < 0.72 && gy > 0.35 && gy < 0.78 && abs(dx) < halfW - 1.0 * decorScale) {
      float wid = floor((dx + halfW) / (3.0 * decorScale)) + floor(v / (3.0 * decorScale)) * 17.0;
      if (night && slotHash(seed * 91.0 + wid, 3.0) > 0.35) { lit = true; return vec4(lin(vec3(1.0, 0.80, 0.45)), 1.0); }
      return vec4(lin(night ? vec3(0.08, 0.10, 0.14) : vec3(0.36, 0.46, 0.55)), 1.0);
    }
    return vec4(wallCol, 1.0);
  }
  float rv = v - wallH;
  if (rv >= 0.0 && rv < roofH) {
    float roofHalf = block ? halfW + 0.3 * decorScale : (halfW + 0.6 * decorScale) * (1.0 - rv / roofH);
    if (roofGone) { // bare rafters only
      if (block) return vec4(0.0);
      float k = fract((dx + halfW) / (2.2 * decorScale));
      if (abs(dx) < roofHalf && (k < 0.12 || abs(abs(dx) - roofHalf) < 0.25 * decorScale) && rv < roofH * 0.7) return vec4(lin(vec3(0.22, 0.15, 0.10)), 1.0);
      return vec4(0.0);
    }
    if (abs(dx) < max(roofHalf, pxM * 0.5)) {
      float n = texture(noiseTex, vec2(dx, rv) * 0.35 + seed * 5.1).r;
      if (n < holes) return vec4(lin(vec3(0.22, 0.15, 0.10)), 1.0); // torn-off tiles: rafters show
      if (snowCover > 0.0 && rv > roofH - (block ? roofH : 0.6 * decorScale) - (roofHalf - abs(dx)) * 0.15) return vec4(mix(roofCol, vec3(1.0), snowCover), 1.0);
      return vec4(roofCol, 1.0);
    }
  }
  if (!block && !longere && !chalet && !town && !roofGone && rv > roofH * 0.3 && rv < roofH * 0.9 && abs(dx - halfW * 0.45) < 0.45 * decorScale) return vec4(lin(vec3(0.45, 0.32, 0.25)), 1.0); // chimney
  return vec4(0.0);
}

// Trees and houses covering this pixel. Returns alpha 0 when there is nothing here.
// Ground columns (x-2 .. x+2) are read lazily: only when an object standing on them could reach this pixel.
// Pieces thrown off by a gust (leaves, branches, tiles): count pieces from an object at height srcY, spread over
// srcW meters, flying downwind (dir) over about range meters, up then down to the ground, during anim 0..1.
vec4 debrisBurst(float dx, float v, float anim, float dir, float srcY, float srcW, float range, float size, vec3 col1, vec3 col2, float seed, float pxM, int count)
{
  if (anim >= 1.0) return vec4(0.0);
  for (int i = 0; i < 14; i++) {
    if (i >= count) break;
    vec4 hk = hash4(seed * 911.0 + float(i) * 13.0);
    float t = clamp(anim * (1.15 + hk.x * 0.4) - hk.y * 0.15, 0.0, 1.0); // staggered start
    if (t <= 0.0) continue;
    float y0 = srcY + (hk.w - 0.5) * srcW * 0.4;
    float px = (hk.z - 0.5) * srcW + dir * t * range * (0.6 + 0.6 * hk.x);
    float py = max(y0 + t * range * 0.25 * hk.y - t * t * (y0 + range * 0.25 * hk.y), size * 0.2);
    float sz = max(size * (0.7 + 0.6 * hk.w), pxM * 0.9);
    vec2 d = vec2(dx - px, v - py);
    float a = t * 12.0 * (hk.z - 0.5);
    vec2 r = vec2(cos(a) * d.x + sin(a) * d.y, -sin(a) * d.x + cos(a) * d.y);
    if (abs(r.x) < sz && abs(r.y) < sz * 0.45) return vec4(mix(col1, col2, step(0.6, hk.y)), 1.0);
  }
  return vec4(0.0);
}

// Leaves (and roof tiles over towns) carried by a strong wind, drawn as a moving field of small pieces.
vec4 flyingDebris(float xm, float v, float windKmh, float amount, bool tiles, float topM, float pxM)
{
  float w = abs(windKmh);
  float minW = tiles ? 110.0 : 45.0;
  if (w < minW || amount <= 0.0) return vec4(0.0);
  amount *= clamp((w - minW) / 60.0, 0.0, 1.0) * (1.0 - smoothstep(topM * 0.7, topM * 1.4, v));
  if (amount <= 0.0) return vec4(0.0);
  float G = 3.0 * decorScale;                                   // one candidate piece per G x G meters
  float phase = iterNum * 0.05 * decorScale * sign(windKmh);    // drift downwind
  vec2 P = vec2(xm - phase, v);
  vec2 cell = floor(P / G);
  vec4 hk = hash4(cell.x * 0.37 + cell.y * 57.13);
  if (hk.x > amount * (tiles ? 0.25 : 0.5)) return vec4(0.0);
  vec2 ctr = (cell + 0.2 + 0.6 * hk.yz) * G;
  ctr.y += sin(iterNum * 0.02 + hk.w * 6.3) * G * 0.2;          // flutter up and down
  vec2 d = P - ctr;
  float a = iterNum * 0.05 * (hk.w - 0.5);
  vec2 r = vec2(cos(a) * d.x + sin(a) * d.y, -sin(a) * d.x + cos(a) * d.y);
  float sz = max((tiles ? 0.5 : 0.35) * decorScale, pxM * 0.9);
  if (abs(r.x) < sz && abs(r.y) < sz * 0.45) {
    vec3 c = tiles ? lin(mix(vec3(0.55, 0.25, 0.17), vec3(0.32, 0.30, 0.30), step(0.5, hk.y)))
                   : lin(mix(vec3(0.30, 0.46, 0.16), vec3(0.62, 0.62, 0.22), hk.y));
    return vec4(c, 1.0);
  }
  return vec4(0.0);
}

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

float treeDensity(Column c) { return c.type == WALLTYPE_LAND ? clamp((c.vegetation - 50.0) / 77.0, 0.0, 1.0) : c.type == WALLTYPE_URBAN ? (1.0 - clamp(c.vegetation / 75.0, 0.0, 1.0)) * 0.35 : 0.0; }

vec4 drawDecor(vec2 frag, bool night, out bool lit, out bool isTree)
{
  lit = false;
  isTree = false;
  float row = floor(frag.y);
  float pxM = fwidth(frag.x) * cellHeight; // meters per screen pixel
  float colX = floor(frag.x);
  for (int k = 0; k < 5; k++) decorHave[k] = false;

  float windKmh = base.x * kmhPerRaw;
  Column cHere = decorColumn(2, colX, row);
  float vHere = cHere.valid ? (frag.y - cHere.groundTop) * cellHeight : 0.0;

  // leaves (and roof tiles over towns) carried by a strong wind, in front of everything
  if (cHere.valid) {
    bool townHere = cHere.type == WALLTYPE_URBAN;
    float amount = townHere ? clamp(cHere.vegetation / 75.0, 0.0, 1.0) * step(100.0, cHere.gust) + 0.5 * treeDensity(cHere) : treeDensity(cHere);
    vec4 fd = flyingDebris(frag.x * cellHeight, vHere, windKmh, amount, townHere && cHere.gust >= 100.0, 30.0 * decorScale, pxM);
    if (fd.a > 0.0) return fd;
  }

  // houses first (in front of trees). A front row of slots every 14 m and, in towns denser than a hamlet, a darker
  // back row of taller buildings in between. The Urban brush intensity (stored as vegetation 0..75) decides how
  // many are built: hamlet .. dense centre. Sizes never change.
  float houseSp = 14.0 * decorScale / cellHeight;                   // slot spacing in cells
  float houseReach = min(10.0 * decorScale / cellHeight, 2.0);      // max half width of a house, in cells
  int housePasses = cHere.valid && cHere.type == WALLTYPE_URBAN && cHere.vegetation > 26.0 ? 2 : 1;
  for (int pass = 0; pass < 2; pass++) {
    if (pass >= housePasses) break;
    float off = pass == 0 ? 0.0 : 0.5;
    float hs0 = floor((frag.x - houseReach) / houseSp - off - 0.5), hs1 = floor((frag.x + houseReach) / houseSp - off + 0.5);
    for (int i = 0; i < 12; i++) {
      float s = hs0 + float(i);
      if (s > hs1) break;
      float sid = s + off * 1000.0;
      vec4 ha = hash4(sid * 2.71 + 5.0); // x: jitter, y: built?, z: kind, w: resistance
      float xc = (s + off + 0.5 + (ha.x - 0.5) * 0.15) * houseSp;
      int ci = int(floor(xc) - colX) + 2;
      if (ci < 0 || ci > 4) continue;
      Column c = decorColumn(ci, colX, row);
      if (!c.valid || c.type != WALLTYPE_URBAN) continue;
      float d = clamp(c.vegetation / 75.0, 0.0, 1.0);
      float fill = pass == 0 ? 0.15 + 0.85 * d : clamp((d - 0.35) * 1.6, 0.0, 1.0);
      if (ha.y > fill) continue;
      // dense centres: mostly narrow town houses; back row: town houses and blocks
      float kind = ha.z;
      if (pass == 1) kind = ha.z < 0.55 ? -1.0 : 0.95;
      else if (ha.z < d * 0.75) kind = -1.0;
      float seedH = slotHash(sid, 5.0);
      float resist = 0.9 + 0.2 * ha.w;
      float dx = (frag.x - xc) * cellHeight, v = (frag.y - c.groundTop) * cellHeight;
      // tiles and pieces of roof thrown off by the last peak gust
      if (c.anim < 1.0 && c.gust > c.prevGust) {
        bool tilesOff = (c.prevGust < 100.0 * resist && c.gust >= 100.0 * resist) || (c.prevGust < 140.0 * resist && c.gust >= 140.0 * resist);
        bool roofOff = c.prevGust < 185.0 * resist && c.gust >= 185.0 * resist;
        if (tilesOff || roofOff) {
          vec3 rc = lin(seedH > 0.4 ? vec3(0.58, 0.25, 0.17) : vec3(0.30, 0.32, 0.35));
          vec4 bc = debrisBurst(dx, v, c.anim, c.fallDir, 7.0 * decorScale, 10.0 * decorScale, 30.0 * decorScale, 0.6 * decorScale, rc, lin(vec3(0.42, 0.30, 0.20)), sid, pxM, roofOff ? 14 : 8);
          if (bc.a > 0.0) return bc;
        }
      }
      vec4 hc = drawHouse(dx, v, kind, c.gust, resist, seedH, pxM, c, night, lit);
      if (hc.a > 0.0) {
        if (pass == 1 && !lit) hc.rgb *= 0.78;
        return hc;
      }
    }
  }

  // trees: a front row of slots every 6 m and, in dense woods, a darker back row in between. The Land brush
  // intensity (vegetation 50..127) sets the share of filled slots: ~1 tree / 30 m up to a closed canopy.
  float treeSp = 6.0 * decorScale / cellHeight;
  float treeReach = min(16.0 * decorScale / cellHeight, 2.0); // max crown radius + bend, in cells
  float flutterT = iterNum * 0.03;
  int passes = cHere.valid && treeDensity(cHere) > 0.45 ? 2 : 1; // the back row only exists in dense woods
  for (int pass = 0; pass < 2; pass++) {
    if (pass >= passes) break;
    float off = pass == 0 ? 0.0 : 0.5;
    float ts0 = floor((frag.x - treeReach) / treeSp - off - 0.5), ts1 = floor((frag.x + treeReach) / treeSp - off + 0.5);
    for (int i = 0; i < 24; i++) {
      float s = ts0 + float(i);
      if (s > ts1) break;
      float sid = s + off * 1000.0;
      vec4 ha = hash4(sid * 3.17 + 11.0); // x: position jitter, y: filled?, z: species, w: height
      float xc = (s + off + 0.5 + (ha.x - 0.5) * 0.6) * treeSp;
      int ci = int(floor(xc) - colX) + 2;
      if (ci < 0 || ci > 4) continue;
      Column c = decorColumn(ci, colX, row);
      if (!c.valid) continue;
      float density = treeDensity(c);
      float fill = pass == 0 ? min(1.0, 0.2 + 0.95 * density * density + 0.25 * density) : clamp((density - 0.5) * 2.2, 0.0, 1.0);
      if (density <= 0.02 || ha.y > fill) continue;
      int sp = ha.z < 0.35 ? 0 : ha.z < 0.6 ? 1 : ha.z < 0.75 ? 2 : 3;
      vec2 hr = sp == 0 ? vec2(17., 24.) : sp == 1 ? vec2(20., 30.) : sp == 2 ? vec2(22., 32.) : vec2(14., 20.);
      float h = mix(hr.x, hr.y, ha.w) * decorScale;
      float dx = (frag.x - xc) * cellHeight;
      float v = (frag.y - c.groundTop) * cellHeight;
      vec4 hb = hash4(sid * 5.31 + 77.0); // x: resistance, y: seed
      float resist = 0.88 + 0.24 * hb.x;
      // leaves and branches thrown off by the last peak gust
      if (c.anim < 1.0 && c.gust > c.prevGust) {
        vec3 thr = speciesThresholds(sp) * resist;
        bool leavesOff = c.prevGust < thr.x && c.gust >= thr.x;
        bool branchOff = c.prevGust < thr.y && c.gust >= thr.y;
        bool felled = c.prevGust < thr.z && c.gust >= thr.z;
        if (leavesOff || branchOff || felled) {
          vec3 lc = lin(speciesLeaf(sp));
          vec3 c2 = branchOff ? (sp == 3 ? lin(vec3(0.85, 0.83, 0.78)) : lin(vec3(0.36, 0.27, 0.19))) : lc * 1.3;
          vec4 bc = debrisBurst(dx, v, c.anim, c.fallDir, h * 0.65, h * 0.5, h * 1.1, 0.5 * decorScale, lc, c2, hb.y * 97.0 + sid, pxM, felled ? 14 : 9);
          if (bc.a > 0.0) { isTree = true; return bc; }
        }
      }
      if (v > h * 1.05 || abs(dx) > h * 1.05) continue; // cheap reject before shaping (fallen trees reach ~h)
      float stiff = sp == 1 ? 0.8 : sp == 2 ? 1.3 : 1.0; // pines stiffer, poplars more flexible
      float aw = min(abs(windKmh) / 30.0, 1.0);
      float flutter = sin(flutterT + s * 1.7) * 0.05 * aw;              // quick shiver of the leaves
      float gustSway = 0.8 + 0.4 * sin(flutterT * 0.35 + s * 0.9);         // slower sway with the gusts
      float bend = clamp(windKmh / 100.0 * 0.32 * stiff * gustSway + flutter, -0.6, 0.6);
      if (c.gust < 110.0) { // certainly standing: reject points outside the bent crown's width
        float halfW = sp == 1 ? 0.23 * h : speciesCrown(sp).x * h * 1.3;
        if (abs(dx - stemLean(min(v, h), h, bend)) > halfW + abs(bend) * 0.4 * h + pxM) continue; // crown is bent as a block
      }
      vec4 tc = drawTree(dx, v, h, sp, bend, resist, hb.y, pxM, pass == 0 ? 1.0 : 0.72, c);
      if (tc.a > 0.0) { isTree = true; return tc; }
    }
  }

  // undergrowth: shrubs filling the space under the crowns of a dense wood
  Column c0 = cHere;
  if (c0.valid && c0.type == WALLTYPE_LAND) {
    float density = treeDensity(c0);
    float ub = clamp((density - 0.4) / 0.4, 0.0, 1.0);
    if (ub > 0.0) {
      float v = (frag.y - c0.groundTop) * cellHeight;
      float xm = frag.x * cellHeight;
      float shrubH = (1.5 + 2.5 * texture(noiseTex, vec2(xm * 0.05, 0.37)).r) * ub * decorScale * 0.6;
      if (v < shrubH) {
        float n = texture(noiseTex, vec2(xm, v) * 0.15).r;
        vec3 leaf = lin(vec3(0.20, 0.34, 0.14)) * (0.65 + 0.4 * n) * mix(0.7, 1.0, v / max(shrubH, 0.01));
        isTree = true;
        return vec4(leaf, 1.0);
      }
    }
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
      float decorTopCells = 33.0 * decorScale / cellHeight + 1.0;
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
