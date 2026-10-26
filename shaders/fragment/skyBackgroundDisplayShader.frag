#version 300 es
precision highp float;
precision highp sampler2D;
precision highp isampler2D;

in vec2 fragCoord;
in vec2 texCoord;

uniform vec2 resolution;
uniform vec2 texelSize;
uniform vec2 aspectRatios;

uniform sampler2D lightTex;
uniform sampler2D planeTex;
uniform sampler2D planeGearTex;

uniform sampler2D ambientLightTex;

uniform float minShadowLight;

uniform float iterNum;

uniform float simHeight;

uniform vec2 planeDirectionAndGearPos;

uniform vec3 planePos;

uniform vec3 view;          // camera Xpos Ypos Zoom
uniform float sunAngle;     // solar zenith angle in radians, 0 = overhead, negative = sun on the left (morning), |angle| > PI/2 = below the horizon
uniform float month;        // 1.0 .. 13.0, drives the moon phase
uniform float skyEffects;   // 1.0 = sun, moon, stars, twilight colors; 0.0 = classic flat sky

out vec4 fragmentColor;

float light;

vec3 ambientLight;

const float dryLapse = 0.; // definition needed for common.glsl
#include "common.glsl"

#include "commonDisplay.glsl"

vec4 displayA380(vec2 pos, float angle, out vec3 emittedLight, out vec3 onLight)
{
  vec2 planeTexCoord = texCoord;

  bool planeDir = planeDirectionAndGearPos[0] == 1.; // true = left, false = right

  planeTexCoord.x -= mod(pos.x, 1.);
  // planeTexCoord.x = realMod(planeTexCoord.x, 1.0);
  planeTexCoord.y -= pos.y;
  float cellHeight = simHeight / resolution.y;

  float scaleMult = 60.0 / cellHeight; // 6000

  planeTexCoord.x *= scaleMult * aspectRatios.x;
  planeTexCoord.y *= -scaleMult;

  // planeTexCoord.y -= 0.7;

  // rotate

  float sin_factor = sin(angle);
  float cos_factor = cos(angle);

  planeTexCoord = vec2(planeTexCoord.x, planeTexCoord.y) * mat2(cos_factor, sin_factor, -sin_factor, cos_factor);

  planeTexCoord *= 0.15;              // scale
  planeTexCoord *= vec2(500., 1000.); // Aspect ratio

  planeTexCoord += vec2(0.5, 0.6);    // center rotation point


  if (planeTexCoord.x < 0.01 || planeTexCoord.x > 1.01 || planeTexCoord.y < 0.01 || planeTexCoord.y > 1.01) // prevent edge effect when mipmapping
    return vec4(0);

  vec2 gearTexCoord = vec2(planeDir ? planeTexCoord.x - 0.10 : 0.90 - planeTexCoord.x, (planeTexCoord.y - 0.46 + planeDirectionAndGearPos[1] * 0.01)) * 2.0;

  vec4 outputCol = texture(planeTex, planeTexCoord);

  vec2 planeFragCoord = planeTexCoord * vec2(1000., 500.);

  float T = mod(iterNum, 60.) / 60.;

  emittedLight += (planeDir ? vec3(1., 0., 0.) : vec3(0., 1., 0.)) * 5. * max(3. - length(planeFragCoord - vec2(planeDir ? 611. : 391., 287.)), 0.);      // wing red/green continuous light
  emittedLight += vec3(1., 1., 1.) * 5. * max(3. - length(planeFragCoord - vec2(planeDir ? 861. : 138., 286.)), 0.);                                      // Tail white continuous light

  emittedLight += vec3(1., 0., 0.) * 20. * max(7. - length(planeFragCoord - vec2(planeDir ? 341. : 659., 256.)), 0.) * ((T > 0.5 && T < 0.55) ? 1. : 0.); // red beacon light top

  emittedLight += vec3(1., 0., 0.) * 10. * max(5. - length(planeFragCoord - vec2(planeDir ? 460. : 540., 347.)), 0.) * ((T > 0.5 && T < 0.55) ? 1. : 0.); // red beacon light bottem

  emittedLight +=
    vec3(0.50, 0.65, 1.) * 30. * max(7. - length(planeFragCoord - vec2(planeDir ? 611. : 387., 287.)), 0.) * (((T > 0.0 && T < 0.05) || (T > 0.10 && T < 0.15)) ? 1. : 0.); // white wing beacon light

  emittedLight += vec3(1., 1., 1.) * 20. * max(7. - length(planeFragCoord - vec2(planeDir ? 861. : 138., 286.)), 0.) * ((T > 0.0 && T < 0.05) ? 1. : 0.);                   // Tail white beacon light


  float planeCenterLight = texture(lightTex, pos)[0]; // W/m2

  if (planeCenterLight < 100.0) {                     // if dark

                                                      // logo lights:
    onLight += vec3(1., 1., 1.) * (1. - smoothstep(0.0, 130.0, length(planeFragCoord - vec2(planeDir ? 800. : 210., 170.)))); // Tail logo

    // landing lights:
    if (planeDirectionAndGearPos[1] < 2.0) {                                                                                   // gear extended
      emittedLight += vec3(0.8, 0.9, 1.0) * 30. * max(3. - length((planeFragCoord - vec2(planeDir ? 170. : 836., 350.))), 0.); // Front gear landing light

      emittedLight += vec3(0.8, 0.9, 1.0) * 30. * max(3. - length((planeFragCoord - vec2(planeDir ? 336. : 660., 323.))), 0.); // Wing landing light

      onLight += vec3(1., 1., 1.) * 0.9 * (1. - smoothstep(0.0, 150.0, length(planeFragCoord - vec2(planeDir ? 220. : 770., 400.))));
    }
  }

  if (outputCol.a < 0.5)
    outputCol += texture(planeGearTex, gearTexCoord);

  onLight *= outputCol.a; // only shine on plane itself
  return outputCol;
}


// ===================== Sky: sun, moon, stars, twilight =====================
// Adapted from the 2D Weather Sandbox Extra fork by Weatherin2D (GPL-3.0,
// https://github.com/Weatherin2D/2D-Weather-Sandbox-Extra), simplified to a single sun position driven by
// the sim's own solar zenith angle and fixed palettes instead of per-column sun data and tunable uniforms.
// Everything is in sim texture coordinates (texCoord: x across the map, y = 0 ground .. 1 top of the sim),
// so the sun and moon stay anchored to the map like everything else.

const float SKY_HORIZON = 0.0;       // texCoord.y of the visual horizon
const float SUN_HORIZ_AMPLITUDE = 0.42;
const float SUN_VERT_SCALE = 0.85;

const vec3 TWILIGHT_TOP = vec3(0.02, 0.03, 0.10);
const vec3 TWILIGHT_UPPER = vec3(0.10, 0.13, 0.32);
const vec3 TWILIGHT_MID = vec3(0.42, 0.30, 0.46);
const vec3 TWILIGHT_LOW = vec3(0.88, 0.50, 0.32);
const vec3 TWILIGHT_HORIZON = vec3(1.00, 0.62, 0.30);
const vec3 HORIZON_DEEP_RED = vec3(0.78, 0.16, 0.08);
const vec3 HORIZON_BURNT_ORANGE = vec3(0.96, 0.42, 0.12);
const vec3 HORIZON_GOLD = vec3(1.00, 0.72, 0.32);
const vec3 HORIZON_PALE_GOLD = vec3(1.00, 0.88, 0.62);
const vec3 CREPUSCULAR_COLOR = vec3(1.00, 0.74, 0.44);

vec2 skyLocal(vec2 uv, vec2 center)
{
  vec2 d = uv - center;
  d.x *= aspectRatios.x; // round in screen space
  return d;
}

float sunGlow(vec2 uv, vec2 center, float radius, float sharpness)
{
  float d = length(skyLocal(uv, center));
  return exp(-pow(d / max(radius, 1e-5), 2.0) * sharpness);
}

// Gold sun disc with soft halo and starburst rays, clipped at the horizon so it rises and sets gradually.
vec3 renderSun(vec2 uv, vec2 center, float scatter, out float emit)
{
  vec2 d = skyLocal(uv, center);
  float dist = length(d);
  float angle = atan(d.y, d.x);
  float horizonClip = smoothstep(SKY_HORIZON - 0.002, SKY_HORIZON + 0.002, uv.y);

  vec3 warmYellow = vec3(0.98, 0.78, 0.38);
  vec3 haloYellow = vec3(0.95, 0.68, 0.28);
  vec3 sunTint = mix(vec3(0.96, 0.82, 0.48), sunColor(scatter), scatter * 0.85);

  float core = sunGlow(uv, center, 0.020, 3.0);
  float innerGlow = sunGlow(uv, center, 0.045, 1.5);
  float outerGlow = sunGlow(uv, center, 0.110, 0.6);

  float rays12 = pow(abs(sin(angle * 6.0)), 28.0);
  float rays8 = pow(abs(cos(angle * 4.0 + 0.4)), 22.0);
  float raySeed = fract(sin(floor(angle * 7.64 + 10.0) * 127.1) * 43758.5453);
  float rayLen = mix(0.55, 1.0, raySeed);
  float rayBand = smoothstep(0.20 * rayLen, 0.0, dist) * (1.0 - smoothstep(0.034, 0.080, dist));
  float starburst = (rays12 * 0.85 + rays8 * 0.45) * rayBand;

  vec3 core_col = mix(vec3(0.98, 0.86, 0.55), vec3(0.95, 0.58, 0.18), scatter);
  vec3 sunLit = core_col * core * 2.2;
  sunLit += mix(warmYellow, sunTint, scatter * 0.5) * innerGlow * 1.05;
  sunLit += mix(haloYellow, vec3(0.92, 0.42, 0.10), scatter) * outerGlow * 0.55;
  sunLit += mix(warmYellow, sunTint, scatter * 0.65) * starburst * 1.15;

  emit = (core * 2.6 + innerGlow * 0.75 + starburst * 0.55 + outerGlow * 0.22) * horizonClip;
  return sunLit * horizonClip;
}

// Moon with a phase terminator and a faint glow.
vec3 renderMoon(vec2 uv, vec2 center, float phase)
{
  vec2 p = skyLocal(uv, center);
  float dist = length(p);
  const float radius = 0.040;
  float glow = exp(-pow(dist / 0.09, 2.0)) * 0.12;
  if (dist > radius + 0.006)
    return vec3(0.75, 0.80, 0.95) * glow;

  float terminator = -cos(phase * 6.2831853) * 1.05;
  float lit = smoothstep(terminator - 0.1, terminator + 0.1, p.x / radius);
  float edge = 1.0 - smoothstep(radius - 0.003, radius + 0.003, dist);
  return mix(vec3(0.10, 0.11, 0.16), vec3(0.92, 0.93, 0.98), lit) * edge + vec3(0.75, 0.80, 0.95) * glow * lit;
}

// Twinkling stars on a jittered world-anchored grid, a constant size on screen whatever the zoom.
vec3 renderStars(vec2 uv)
{
  vec2 p = vec2(uv.x * aspectRatios.x, uv.y);
  const float gridSize = 0.035;
  vec2 cell = floor(p / gridSize);
  float r1 = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  if (r1 < 0.80)
    return vec3(0.0);
  float r2 = fract(sin(dot(cell + 100.0, vec2(39.346, 57.123))) * 23421.1234);
  float r3 = fract(sin(dot(cell + 200.0, vec2(73.456, 12.789))) * 12345.6789);
  vec2 starPos = (cell + 0.2 + 0.6 * vec2(r2, r3)) * gridSize;
  float pixel = fwidth(p.y);
  float size = pow(r2, 3.0);
  float radius = pixel * (0.9 + size * 1.6);
  float dist = length(p - starPos);
  float twinkle = pow(sin(iterNum * (0.02 + r3 * 0.06) + r1 * 100.0) * 0.5 + 0.5, 2.0);
  float brightness = (0.35 + size * 1.4) * smoothstep(radius, radius * 0.3, dist) * mix(0.45, 1.0, twinkle);
  return mix(vec3(1.0, 1.0, 0.95), vec3(0.82, 0.88, 1.0), r3) * brightness;
}

void main()
{
  vec2 lightTexCoord = vec2(texCoord.x, min(texCoord.y + texelSize.y * 0.5, 1.0 - texelSize.y)); // limit vertical sample position to top of simulation

  light = texture(lightTex, lightTexCoord)[0] / standardSunBrightness;
  ambientLight = texture(ambientLightTex, texCoord).rgb;

  float hue = 0.6;
  float sat = map_rangeC(texCoord.y, 0., 2.5, 0.7, 1.0); // more blue at the top
  float val = pow(map_rangeC(texCoord.y, 0., 3.2, 1.0, 0.05), 5.0); // pow 5 map 1.0 to 0.1
  vec3 mixedCol = hsv2rgb(vec3(hue, sat, val));                     // blue air

  vec3 celestialCol = vec3(0.0); // sun, moon, stars: added on top, unaffected by cloud shadow
  float warmCapAmount = 0.0;

  if (skyEffects > 0.5) {
    float zenith = sunAngle;
    float absZenith = abs(zenith);
    float sunElev = PI * 0.5 - absZenith;
    float sunHoriz = 0.5 + SUN_HORIZ_AMPLITUDE * sin(zenith);
    float sunVert = SKY_HORIZON + SUN_VERT_SCALE * sin(clamp(sunElev, -PI * 0.5, PI * 0.5));
    vec2 sunCenter = vec2(sunHoriz, sunVert);
    float sunRiseAmount = sunVert - SKY_HORIZON;

    float scatter = clamp(map_range(absZenith, 75.0 * deg2rad, 88.0 * deg2rad, 0.0, 1.0), 0.0, 1.0);
    float deepNightSky = clamp(map_range(absZenith, 88.0 * deg2rad, 96.0 * deg2rad, 0.0, 1.0), 0.0, 1.0);
    scatter *= 1.0 - deepNightSky;
    float sunVisibility = (1.0 - smoothstep(1.62, 1.70, absZenith));

    float skyHeight = clamp((texCoord.y - SKY_HORIZON) / (1.0 - SKY_HORIZON), 0.0, 1.0);
    float morningW = 1.0 - smoothstep(-0.18, 0.18, zenith);

    // How much of the sky takes the twilight palette (sunrise and sunset ramp slightly differently)
    float twilightMorning = max(smoothstep(0.03, 0.16, sunRiseAmount) * (1.0 - smoothstep(0.16, 0.38, sunRiseAmount)),
                                smoothstep(1.32, 1.50, absZenith) * smoothstep(-0.10, 0.10, sunRiseAmount) * 0.85);
    float twilightEvening = max(smoothstep(0.05, 0.48, scatter) * (1.0 - smoothstep(0.04, 0.30, sunRiseAmount)),
                                smoothstep(1.22, 1.50, absZenith) * smoothstep(-0.10, 0.14, sunRiseAmount));
    float twilightAmt = clamp(mix(twilightEvening, twilightMorning, morningW), 0.0, 1.0) * (1.0 - deepNightSky);

    // Warm gold at the horizon -> violet bands -> dark zenith
    vec3 horizonWarm = mix(TWILIGHT_HORIZON, HORIZON_GOLD, clamp(scatter * 0.95, 0.0, 1.0)) * 0.78;
    vec3 twilightSky = mix(horizonWarm, TWILIGHT_LOW * 0.82, smoothstep(0.0, 0.14, skyHeight));
    twilightSky = mix(twilightSky, TWILIGHT_MID * 0.90, smoothstep(0.10, 0.36, skyHeight));
    twilightSky = mix(twilightSky, TWILIGHT_UPPER * 0.75, smoothstep(0.28, 0.62, skyHeight));
    twilightSky = mix(twilightSky, TWILIGHT_TOP * 0.55, smoothstep(0.52, 0.86, skyHeight));

    vec2 relSun = skyLocal(texCoord, vec2(sunHoriz, SKY_HORIZON + 0.04));
    float sunWarmth = exp(-length(relSun) * 1.2) * (0.35 + scatter * 0.30) * (1.0 - smoothstep(0.48, 0.88, skyHeight));
    twilightSky = mix(twilightSky, vec3(0.88, 0.62, 0.24), sunWarmth * twilightAmt * 0.55);

    mixedCol = mix(mixedCol, twilightSky, smoothstep(0.0, 1.0, twilightAmt));

    // Horizon haze: sunrise deep red -> gold -> pale; sunset pale -> gold -> burnt orange -> deep red
    float horizonBand = exp(-pow(max(texCoord.y - SKY_HORIZON, 0.0) / 0.12, 2.0) * 0.7);
    float sunProximity = exp(-pow((texCoord.x - sunHoriz) * aspectRatios.x * 0.8, 2.0));
    float bandMask = horizonBand * (0.55 + sunProximity * 0.45);

    float riseT = smoothstep(0.02, 0.20, sunRiseAmount);
    vec3 hazeMorning = mix(HORIZON_DEEP_RED, mix(HORIZON_GOLD, HORIZON_PALE_GOLD, smoothstep(0.08, 0.18, sunRiseAmount)), riseT);
    float hazeBoostMorning = max(smoothstep(0.0, 0.08, sunRiseAmount), (1.0 - smoothstep(0.10, 0.30, sunRiseAmount)) * smoothstep(0.04, 0.14, sunRiseAmount));
    float setT = 1.0 - smoothstep(0.05, 0.26, sunRiseAmount);
    vec3 hazeEvening = mix(HORIZON_PALE_GOLD, mix(HORIZON_GOLD, mix(HORIZON_BURNT_ORANGE, HORIZON_DEEP_RED, smoothstep(0.25, 1.0, setT)), smoothstep(0.0, 0.5, setT)), smoothstep(0.0, 0.4, setT));
    float hazeBoostEvening = max(smoothstep(0.02, 0.92, scatter) * (1.0 - smoothstep(0.02, 0.32, sunRiseAmount)),
                                 smoothstep(1.24, 1.50, absZenith) * smoothstep(-0.05, 0.14, sunRiseAmount));
    vec3 hazeCol = mix(hazeEvening, hazeMorning, morningW);
    float hazeBoost = mix(hazeBoostEvening, hazeBoostMorning, morningW) * (1.0 - deepNightSky);

    float hazeStrength = clamp(twilightAmt * 0.85 + hazeBoost * bandMask, 0.0, 1.0) * smoothstep(0.18, 0.55, scatter + twilightAmt * 0.35);
    mixedCol = mix(mixedCol, hazeCol * 0.80, hazeStrength * 0.72);
    mixedCol += hazeCol * bandMask * hazeBoost * sunProximity * 0.38 * smoothstep(0.22, 0.60, scatter + twilightAmt * 0.3);

    // Crepuscular rays fanning out from the low sun
    if (twilightAmt > 0.15 || scatter > 0.3) {
      vec2 rel = skyLocal(texCoord, sunCenter);
      float ang = atan(rel.y, rel.x);
      float rays = pow(max(cos(ang * 4.0 + 0.2), 0.0), 18.0) + pow(max(cos(ang * 7.0 - 0.5), 0.0), 22.0) * 0.6;
      rays *= exp(-length(rel) * 1.2) * smoothstep(SKY_HORIZON + 0.08, 0.45, texCoord.y);
      mixedCol += CREPUSCULAR_COLOR * rays * clamp(twilightAmt + scatter * 0.5, 0.0, 1.0) * sunVisibility * 0.35;
    }

    // Stars, fading in through twilight, hidden near the ground haze
    float night = smoothstep(1.45, 1.70, absZenith);
    if (night > 0.0)
      celestialCol += renderStars(texCoord) * night * smoothstep(0.05, 0.25, texCoord.y);

    // Moon, opposite the sun
    float moonElev = clamp(absZenith - PI * 0.5, 0.0, PI * 0.5);
    vec2 moonCenter = vec2(0.5 - SUN_HORIZ_AMPLITUDE * sin(zenith), SKY_HORIZON + SUN_VERT_SCALE * sin(moonElev));
    float moonVisibility = smoothstep(1.55, 1.75, absZenith) * smoothstep(0.0, 0.04, moonElev);
    if (moonVisibility > 0.001)
      celestialCol += renderMoon(texCoord, moonCenter, fract((month - 1.0) * 30.44 / 29.53)) * moonVisibility;

    // Sun disc + glow, tinted by how low it is
    if (sunVisibility > 0.001) {
      float sunEmit;
      celestialCol += renderSun(texCoord, sunCenter, scatter, sunEmit) * sunVisibility;
      float setBlend = 1.0 - smoothstep(0.04, 0.24, sunRiseAmount);
      vec3 glowMorning = mix(vec3(0.95, 0.30, 0.10), vec3(0.92, 0.72, 0.38), smoothstep(0.02, 0.14, sunRiseAmount));
      vec3 glowEvening = mix(vec3(0.92, 0.72, 0.38), vec3(0.95, 0.42, 0.12), smoothstep(0.1, 0.85, setBlend));
      float aboveHorizon = smoothstep(SKY_HORIZON - 0.01, SKY_HORIZON + 0.02, texCoord.y);
      float skyGlow = sunGlow(texCoord, sunCenter, 0.22, 0.55) * (0.20 + scatter * 0.42);
      float wideGlow = exp(-pow(max(texCoord.y - SKY_HORIZON, 0.0) / 0.55, 2.0) * 0.28) * sunProximity * 0.18;
      celestialCol += mix(glowEvening, glowMorning, morningW) * (skyGlow + wideGlow) * 0.62 * aboveHorizon * sunVisibility;
    }

    // Warm the whole sky slightly near the horizon at low sun, and cap warm highlights later
    float horizonWarmth = scatter * (1.0 - smoothstep(0.04, 0.50, skyHeight));
    mixedCol *= mix(vec3(1.0), vec3(1.05, 0.80, 0.50), horizonWarmth * 0.45);
    warmCapAmount = clamp(scatter + twilightAmt * 0.5, 0.0, 1.0);
  }

  vec3 airplaneLights;

  vec3 airplaneOnLight;

  vec4 A380Col = displayA380(planePos.xy, planePos.z, airplaneLights, airplaneOnLight);

  mixedCol *= 1.0 - A380Col.a;
  mixedCol += A380Col.rgb * A380Col.a;
  celestialCol *= 1.0 - A380Col.a;

  vec3 finalColor = mixedCol * (light + minShadowLight + airplaneOnLight);

  // Celestial objects are seen through the clear sky: dimmed where the sky column is shaded by cloud
  finalColor += celestialCol * max(smoothstep(0.06, 0.28, light), 0.35);

  float airDensityFactor = clamp(1.0 - texCoord.y, 0., 1.);

  finalColor += ambientLight * 0.1 * airDensityFactor / standardSunBrightness;

  finalColor += airplaneLights;

  // Soft cap so sunset golds don't clip to white
  float lum = dot(finalColor, vec3(0.2126, 0.7152, 0.0722));
  float cap = mix(1.6, 1.0, warmCapAmount);
  if (lum > cap)
    finalColor *= cap / lum;

  fragmentColor = vec4(finalColor, 1.0);
}
