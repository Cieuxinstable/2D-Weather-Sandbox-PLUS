#version 300 es
precision highp float;
precision highp sampler2D;
precision highp isampler2D;

vec2 fragCoord;          // (in) not used just defined for commonDisplay.glsl
in vec2 texCoord;        // this
in vec2 texCoordXmY0;    // left
in vec2 texCoordX0Ym;    // down
in vec2 texCoordXpY0;    // right
in vec2 texCoordX0Yp;    // up

uniform vec2 resolution; // sim resolution
uniform vec2 texelSize;

uniform float exposure;
uniform float saturation; // colour grading from the EXTRA fork (Weatherin2D/2D-Weather-Sandbox-Extra)
uniform float contrast;

uniform sampler2D hdrTex;
uniform sampler2D bloomTex;
out vec4 fragmentColor;


#include "commonDisplay.glsl"

void main()
{
  vec3 outputCol = texture(hdrTex, texCoord).rgb;

  vec3 bloom = texture(bloomTex, texCoord).rgb;

  outputCol += bloom * 0.990; // apply bloom

  // outputCol = outputCol / (outputCol + vec3(1.0)) * 1.1; // Tone mapping

  outputCol *= exposure;

  outputCol = pow(outputCol, ONE_OVER_GAMMA); // gamma correction

  // Contrast around mid grey, then luminance-preserving saturation (both 1.0 = unchanged)
  // (0 = not uploaded yet: treated as 1)
  outputCol = (outputCol - 0.5) * (contrast > 0.0 ? contrast : 1.0) + 0.5;
  float lum = dot(outputCol, vec3(0.2126, 0.7152, 0.0722));
  outputCol = clamp(mix(vec3(lum), outputCol, saturation > 0.0 ? saturation : 1.0), 0.0, 1.0);


  /*
    { // Gamma correction test: left without, right with gamma correction
      float modTexCoordx = mod(texCoord.x, 0.5);
      // outputCol = vec3(pow(texCoord.y, 2.)); // light input

      outputCol = vec3(pow(0.9, (1. - texCoord.y) * 50.)); // simulate light coming down and being absorbed by clouds

      if (texCoord.x > 0.5)
        outputCol = pow(outputCol, GAMMA);              // gamma correction

      if (abs(outputCol.r - modTexCoordx * 2.) < 0.001) // plot brightness
        outputCol = vec3(1.0, 0., 0.);
    }
  */

  fragmentColor = vec4(outputCol, 1.0);
}
