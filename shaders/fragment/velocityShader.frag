#version 300 es
precision highp float;
precision highp sampler2D;
precision highp isampler2D;

in vec2 fragCoord;
in vec2 texCoord;     // this
in vec2 texCoordXpY0; // right
in vec2 texCoordX0Yp; // up

uniform sampler2D baseTex;
uniform isampler2D wallTex;

uniform float dragMultiplier;

uniform float wind;
uniform float uWindMultiplier; // 1.0 = normal; ramped 1.0 -> 0.0 over 5s by startWindReset() in app.js to cut the global wind force off smoothly, applied here before this frame's pressure projection (pressureProgram, later in the same iteration) rather than touching the velocity field directly
uniform float velMax;         // flow speed limit in cells/iteration, from the "Limite de vent" setting (app.js)

uniform vec2 texelSize;
// uniform vec2 resolution;


// Vertical profiles in a 1-row RGBA32F texture (x = cell row): r = initial temperature, g = sounding temperature,
// b = sounding water, a = sounding wind. A texture instead of uniform arrays: 4 x 152 vec4 uniforms exceeded the
// 256 fragment uniform vectors most phones allow, so the shader failed to compile there and the game never loaded.
uniform sampler2D profileTex;
vec4 profileAt(int y) { return texelFetch(profileTex, ivec2(clamp(y, 0, textureSize(profileTex, 0).x - 1), 0), 0); }
float getInitialT(int y) { return profileAt(y).r; }

layout(location = 0) out vec4 base;
layout(location = 2) out ivec4 wall;

float dryLapse; // NOT USED needs to be declared for common.glsl
vec2 resolution;
#include "common.glsl"

void main()
{
  base = texture(baseTex, texCoord);
  vec4 baseXpY0 = texture(baseTex, texCoordXpY0);
  vec4 baseX0Yp = texture(baseTex, texCoordX0Yp);

  wall = texture(wallTex, texCoord);
  ivec4 wallX0Yp = texture(wallTex, texCoordX0Yp);
  ivec4 wallXpY0 = texture(wallTex, texCoordXpY0);


  // set boundaries: no flow in or out of wall cells
  if (wall[DISTANCE] == 0) // is wall
  {
    base[VX] = 0.0;        // velocities in wall are 0
    base[VY] = 0.0;        // this will make a wall not let any pressure trough and
                           // thereby reflect any pressure waves back
  } else {

    float dragFactor = 1. - dragMultiplier * 0.0002; // linear drag -- same factor applied to both components below, computed once instead of twice

    if (wallXpY0[DISTANCE] == 0) {
      base[VX] = 0.0;                                  // Since X velocity is defined at the right of the cell, it has to be done in the cell to the left of the wall
    } else {
      base[VX] += base[PRESSURE] - baseXpY0[PRESSURE]; // The velocity through the cell changes proportionally to the pressure gradient across the cell. It's basically just newtons 2nd law.
      base[VX] *= dragFactor;
    }

    base[VY] += base[PRESSURE] - baseX0Yp[PRESSURE];
    base[VY] *= dragFactor;
    // quadratic drag
    // base[VX] -= base[VX] * base[VX] * base[VX] * base[VX] * base[VX] *
    // dragMultiplier; base[VY] -= base[VY] * base[VY] * base[VY] * base[VY] *
    // base[VY] * dragMultiplier;

    base[VX] += wind * uWindMultiplier * 0.000001;

    // Wind limit ("Limite de vent", 150 km/h by default): no effect below 90% of it, then the wind is eased so
    // it reaches exactly the limit and never more. Horizontal component only: updrafts and downdrafts are free.
    base[VX] = softLimitSpeed(base[VX], velMax);
  }
}