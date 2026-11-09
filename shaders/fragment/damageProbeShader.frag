#version 300 es
precision highp float;
precision highp sampler2D;
precision highp isampler2D;

// One row (width = sim width): for each column, the ground surface state the damage sounds need.
// out = (storm damage, signed as stored by the boundary shader; ground type; vegetation; surface row, -1 = none)

in vec2 fragCoord;
in vec2 texCoord;

uniform sampler2D waterTex;
uniform vec2 resolution; // declared for common.glsl
uniform vec2 texelSize;
uniform float dryLapse;
uniform isampler2D wallTex;

out vec4 probe;

#include "common.glsl"

void main()
{
  int x = int(fragCoord.x);
  ivec4 w0 = texelFetch(wallTex, ivec2(x, 0), 0);
  int vd = w0[VERT_DISTANCE]; // height above the surface; <= 0 inside the ground
  if (w0[DISTANCE] != 0 || vd > 0) {
    probe = vec4(0.0, -1.0, 0.0, -1.0);
    return;
  }
  int sy = -vd;
  ivec4 ws = texelFetch(wallTex, ivec2(x, sy), 0);
  vec4 wa = texelFetch(waterTex, ivec2(x, sy), 0);
  probe = vec4(wa[CLOUD], float(ws[TYPE]), float(ws[VEGETATION]), float(sy));
}
