#version 300 es
precision mediump float;
#define MAX_LIGHTS 8
in vec2 v_local; in vec4 v_color; in float v_shape; in vec2 v_world;
uniform int u_lightCount;              // active flashlights (one per player)
uniform vec2 u_lightPos[MAX_LIGHTS];   // each light's world origin
uniform vec2 u_lightAim[MAX_LIGHTS];   // each light's normalized aim direction
uniform float u_lightInt[MAX_LIGHTS];  // each cone's brightness (battery/flicker), 0 = off
uniform vec2 u_lightCone[MAX_LIGHTS];  // per-light: x = cos(halfAngle), y = range
uniform float u_ambient; // shared ambient light floor
uniform vec2 u_personal; // shared: x: radius, y: max brightness of the dim pool
uniform float u_emissive;  // darkness floor for this pass (0 normal, >0 additive)
uniform float u_sat; // grade: 1 = full colour, 0 = greyscale
uniform float u_dim; // grade: 1 = normal brightness, 0 = black
out vec4 frag;

/* shape flags: 0 rect, 1 circle, 2 soft glow, 3 ring, 4 triangle, 5 hexagon, 6 slash */

// how lit a world point is: ambient + the brightest of every player's pool/cone
float lightAt(vec2 w){
  float best = 0.0;
  for(int i = 0; i < MAX_LIGHTS; i++){
    if(i >= u_lightCount) break;
    vec2 d = w - u_lightPos[i];
    float dist = length(d);
    // dim bubble right around each player so feet aren't pitch black
    float pool = smoothstep(u_personal.x, u_personal.x * 0.3, dist) * u_personal.y;
    // aimed cone: angle gate * distance falloff * intensity
    vec2 dir = dist > 1e-3 ? d / dist : u_lightAim[i];
    float ca = dot(dir, u_lightAim[i]);
    float e = smoothstep(u_lightCone[i].x, mix(u_lightCone[i].x, 1.0, 0.35), ca);
    float reach = smoothstep(u_lightCone[i].y, u_lightCone[i].y * 0.25, dist);
    float cone = e * reach * u_lightInt[i];
    best = max(best, max(pool, cone));
  }
  return clamp(u_ambient + best, 0.0, 1.0);
}

// regular hexagon signed distance (negative inside), p/r in local space
float sdHex(vec2 p, float r){
  const vec3 k = vec3(-0.8660254, 0.5, 0.5773503);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

// outward (CCW) half-plane distance to edge a->b
float edge(vec2 p, vec2 a, vec2 b){
  vec2 e = b - a;
  vec2 n = normalize(vec2(e.y, -e.x));
  return dot(p - a, n);
}
// triangle pointing +x, signed distance approx (negative inside)
float sdTri(vec2 p){
  float d1 = edge(p, vec2(0.48, 0.0), vec2(-0.42, 0.44));
  float d2 = edge(p, vec2(-0.42, 0.44), vec2(-0.42, -0.44));
  float d3 = edge(p, vec2(-0.42, -0.44), vec2(0.48, 0.0));
  return max(max(d1, d2), d3);
}

// fill + subtle edge shading shared by solid SDF shapes
vec4 solid(float sd){
  float aa = fwidth(sd) + 1e-4;
  float fill = smoothstep(aa, -aa, sd);
  if(fill <= 0.0) discard;
  float t = clamp(-sd / 0.42, 0.0, 1.0);      // 1 at core, 0 at edge
  return vec4(v_color.rgb * (0.72 + 0.28 * t), v_color.a * fill);
}

void main(){
  int s = int(v_shape + 0.5);
  if(s == 1){
    float d = length(v_local);
    if(d > 0.5) discard;
    float a = smoothstep(0.5, 0.46, d);
    float rim = smoothstep(0.5, 0.30, d);
    frag = vec4(v_color.rgb * (0.7 + 0.3 * rim), v_color.a * a);
  } else if(s == 2){
    // soft radial glow (additive layer)
    float g = clamp(1.0 - length(v_local) * 2.0, 0.0, 1.0);
    g = g * g;
    frag = vec4(v_color.rgb, v_color.a * g);
  } else if(s == 3){
    // ring / hollow outline
    float d = length(v_local);
    float dd = abs(d - 0.42);
    float aa = fwidth(d) + 1e-4;
    float a = smoothstep(0.07 + aa, 0.07 - aa, dd);
    if(a <= 0.0) discard;
    frag = vec4(v_color.rgb, v_color.a * a);
  } else if(s == 4){
    frag = solid(sdTri(v_local));
  } else if(s == 5){
    frag = solid(sdHex(v_local, 0.46));
  } else if(s == 6){
    // slash: a crescent blade-arc = an outer disc with an offset disc carved out. The tips
    // run along local y (tangent to the swing arc) and the convex leading edge bulges to +x;
    // it glints brightest along that leading edge for a honed-steel read.
    const float OUTER_R = 0.5;             // outer disc radius
    const float CARVE_OFF = 0.18;          // carve disc pushed toward -x by this much
    const float CARVE_R = 0.52;            // carve disc radius
    float outer = length(v_local) - OUTER_R;
    float inner = length(v_local - vec2(-CARVE_OFF, 0.0)) - CARVE_R;
    float sd = max(outer, -inner);
    float aa = fwidth(sd) + 1e-4;
    float fill = smoothstep(aa, -aa, sd);
    if(fill <= 0.0) discard;
    // glint band tracks the actual fill along +x: inner edge = CARVE_R - CARVE_OFF, lead edge = OUTER_R,
    // so it stays locked to the crescent geometry if the disc radii above are retuned.
    float fillInner = CARVE_R - CARVE_OFF; // where the carve's +x rim cuts the fill
    float t = clamp((length(v_local) - fillInner) / (OUTER_R - fillInner), 0.0, 1.0); // 0 inner → 1 lead
    frag = vec4(v_color.rgb * (0.85 + 0.6 * t), v_color.a * fill);
  } else {
    frag = v_color;
  }
  // normal pass (u_emissive 0) fully darkens; additive pass keeps a floor so
  // glows, muzzle flashes and zombie eyes still read in the dark.
  frag.rgb *= mix(u_emissive, 1.0, lightAt(v_world));
  frag.rgb = mix(vec3(dot(frag.rgb, vec3(0.2126, 0.7152, 0.0722))), frag.rgb, u_sat) * u_dim;
}
