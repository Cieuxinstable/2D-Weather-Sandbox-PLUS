#version 300 es
precision highp float;

in vec2 position_out;
in vec2 mass_out;
in float density_out;
in float cloudAmount_out;
in float zoomVis_out;

uniform float showAllDrops; // 1.0 = debug: render every droplet (rain/snow/hail). 0.0 = normal play: only hail is drawn as a particle

out vec4 fragmentColor;

// Precipitation mass:
#define WATER 0
#define ICE 1

void main()
{

  if (mass_out[WATER] < 0.)
    discard;

  bool isHailParticle = mass_out[ICE] > 0. && density_out >= 1.0; // dense ice, possibly wet/melting: still hail

  if (!isHailParticle && showAllDrops < 0.5)
    discard; // outside debug mode, only hail renders as individual particles

  // Round the square point sprite into an actual circle: gl_PointCoord goes 0..1 across the sprite,
  // so distance from its center (0.5, 0.5) tells us how far out we are; 1.0 = at the sprite's edge.
  float distFromCenter = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (distFromCenter > 1.0)
    discard; // outside the circle: this is a corner of the square sprite, not part of the bubble
  float circleEdgeFade = 1.0 - smoothstep(0.85, 1.0, distFromCenter); // soft antialiased edge

  float opacity = (mass_out[WATER] + mass_out[ICE]) * 0.10;

  if (isHailParticle) {                        // hail: classified by density alone, so it STAYS this color while gradually
                                                // melting instead of vanishing the instant any meltwater appears
    bool debugView = showAllDrops >= 0.5;
    // Normal play: kept subtle so it blends into the scene like real hail/snow instead of glowing.
    // Debug "Show Droplets" overlay: stays strongly visible, since that view exists to be examined closely.
    float hailOpacity = debugView ? clamp(opacity * 3.0 + 0.35, 0.0, 1.0) : clamp(opacity * 2.0 + 0.45, 0.0, 0.92) * zoomVis_out; // seen when zoomed in
    // Red is reserved for the "Show Droplets" debug overlay; in normal play hail is a light, slightly translucent grey.
    vec3 hailColor = debugView ? vec3(1.0, 0.1, 0.1) : vec3(0.93, 0.95, 0.97);

    // Hide hail while it is still inside the cloud base (barely visible, not fully gone) so it only
    // reads as a "curtain" once it actually emerges below the cloud and is falling through clear air.
    float cloudMask = debugView ? 1.0 : mix(1.0, 0.05, smoothstep(0.3, 1.5, cloudAmount_out));

    // position_out.y is the simulation's own -1..1 vertical coordinate, where -1 is the ground: fade
    // hail in as it falls, nearly invisible high up (freshly formed) and fully visible only once close
    // to hitting the surface.
    float groundProximity = debugView ? 1.0 : 1.0 - smoothstep(-0.6, -0.2, position_out.y); // visible from below the cloud base down

    fragmentColor = vec4(hailColor, hailOpacity * cloudMask * groundProximity);
  } else if (mass_out[ICE] > 0.) {              // has ice, not hail
    if (mass_out[WATER] == 0.)                  // pure light ice, no liquid water
      fragmentColor = vec4(1.0, 1.0, 1.0, opacity); // snow, white
    else                                         // wet snow: mix of ice and water
      fragmentColor = vec4(0.5, 1.0, 1.0, opacity); // light blue
  } else {                                      // rain
    fragmentColor = vec4(0.0, 0.5, 1.0, opacity); // dark blue
  }

  fragmentColor.a *= circleEdgeFade;

  // fragmentColor = vec4(1.0, 1.0, 0.0, 1.0); // all highly visible for DEBUG
}