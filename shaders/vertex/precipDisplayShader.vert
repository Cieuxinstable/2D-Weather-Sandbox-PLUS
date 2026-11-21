#version 300 es
precision highp float;

in vec2 dropPosition;
in vec2 mass; //[0] water   [1] ice
in float density;

out vec2 position_out;
out vec2 mass_out;
out float density_out;
out float cloudAmount_out; // how deep inside the cloud layer this hail particle currently is
out float zoomVis_out;     // 0 zoomed out .. 1 zoomed in: hail, as fine as snow, only shows up close

uniform vec2 texelSize;
uniform vec2 aspectRatios;  // sim   canvas
uniform vec3 view;          // Xpos  Ypos    Zoom
uniform float showAllDrops; // 1.0 = debug: render every droplet (rain/snow/hail). 0.0 = normal play: only hail is drawn as a particle
uniform sampler2D waterTex; // sampled only for hail, to fade/shrink it while still inside the cloud
uniform float pxPerMeter;    // screen pixels per meter at zoom 1 (hail is drawn to the same scale as trees and houses)
uniform float decorScale;    // size multiplier of the scenery, applied to hailstones too
uniform float smallHailPass; // 1 = second pass: a small hailstone near each large one (graupel falling with big hail)

void main()
{
  bool isHail = mass[1] > 0. && density >= 1.0;
  float growth = clamp(density - 1.0, 0.0, 1.5) / 1.5;
  vec2 pos = dropPosition;
  float smallHail = 0.0;
  if (smallHailPass > 0.5) {
    // only next to large hail; each large stone gets one small companion at a fixed random offset, a bit higher up
    if (!isHail || growth < 0.4) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0); // off screen
      gl_PointSize = 0.0;
      position_out = dropPosition; mass_out = vec2(-1.0); density_out = 0.0; cloudAmount_out = 0.0; zoomVis_out = 0.0;
      return;
    }
    float id = float(gl_VertexID);
    vec2 r = fract(sin(vec2(id * 12.9898, id * 78.233)) * 43758.5453);
    pos += vec2((r.x - 0.5) * 0.0015, r.y * 0.0015); // a few tens of meters away
    smallHail = 0.35 + 0.25 * r.y; // size as a fraction of a big stone
  }
  vec2 outpos = pos;

  outpos.x += view.x;
  outpos.y += view.y * aspectRatios[0];

  outpos *= view[2]; // zoom

  outpos.y *= aspectRatios[1] / aspectRatios[0];

  gl_Position = vec4(outpos, 0.0, 1.0);

  bool isHailParticle = isHail; // pure/partly-melted dense ice, classified the same way the fragment shader colors it

  float size = 4.0; // 4.0
  cloudAmount_out = 0.0;

  if (isHailParticle) {
    // hailGrowth: 0 right at the CAPE threshold or once nearly melted back to rain density (1.0),
    // 1 at max density (2.5) -- so the point also shrinks towards the small end as it melts, not just
    // scales with CAPE, giving a subtle "shrinking away" look as it nears the warm ground.
    float hailGrowth = clamp(density - 1.0, 0.0, 1.5) / 1.5;
    size = mix(0.6, 5.0, hailGrowth); // diameter 0.6px (r=0.3px) for the thin "curtain" hail -> 5px (r=2.5px) for big hail, unchanged

    // dropPosition is already in the simulation's own -1..1 space (untouched by camera pan/zoom), so it
    // maps directly to a 0..1 texture UV without needing the view/aspect transform used for gl_Position.
    if (smallHail > 0.0) size = max(5.0 * smallHail, 0.8);
    vec2 waterUV = pos * 0.5 + 0.5;
    cloudAmount_out = texture(waterTex, waterUV).y; // CLOUD channel
  } else if (showAllDrops < 0.5) {
    size = 0.0; // outside debug mode, rain/snow are shown via the volumetric cloud/precip fog instead of individual points
  }

  float pointSizePx = view[2] * size / aspectRatios[0]; // scales with camera zoom like every other object in the scene

  zoomVis_out = smoothstep(4.0, 12.0, view[2]);
  if (isHailParticle) {
    // true scale: 0.5 cm (small) to 5 cm (large) hailstones, times the scenery scale, so they stay tiny next to
    // the houses. Below one pixel they are drawn as faint 1 px specks, like fine snow.
    float diamM = mix(0.005, 0.05, isHail ? growth : 0.0) * (smallHail > 0.0 ? smallHail : 1.0) * max(decorScale, 1.0);
    float px = diamM * pxPerMeter * view[2];
    pointSizePx = max(px, 1.0);
    zoomVis_out *= clamp(px * 1.5, 0.35, 1.0);
  } // absolute on-screen cap (diameter 0.6-5px, r=0.3-2.5px): hail must
                                                 // never balloon into a giant disc just because the camera is zoomed in

  gl_PointSize = pointSizePx;

  position_out = pos;
  mass_out = mass;
  density_out = density;
}