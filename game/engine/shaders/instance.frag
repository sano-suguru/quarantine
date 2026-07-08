#version 300 es
precision mediump float;
#define MAX_LIGHTS 8
in vec2 v_local; in vec4 v_color; in float v_shape; in vec2 v_world;
flat in float v_frag;
uniform float u_gridN;
uniform float u_atlasTexel;
uniform int u_lightCount;              // active flashlights (one per player)
uniform vec2 u_lightPos[MAX_LIGHTS];   // each light's world origin
uniform vec2 u_lightAim[MAX_LIGHTS];   // each light's normalized aim direction
uniform float u_lightInt[MAX_LIGHTS];  // each cone's brightness (battery/flicker), 0 = off
uniform vec2 u_lightCone[MAX_LIGHTS];  // per-light: x = cos(halfAngle), y = range
#define MAX_WALLS 32
uniform vec4 u_wall[MAX_WALLS]; // static wall segments (x1,y1,x2,y2), world space
uniform int u_wallCount;
uniform float u_shadowFloor;    // floor brightness where occluded from every light (phase-blended, set CPU-side)
uniform float u_ambient; // shared ambient light floor
uniform vec2 u_personal; // shared: x: radius, y: max brightness of the dim pool
uniform float u_emissive;  // darkness floor for this pass (0 normal, >0 additive)
uniform float u_sat; // grade: 1 = full colour, 0 = greyscale
uniform float u_dim; // grade: 1 = normal brightness, 0 = black
const int MAX_SPRITES = 32;
uniform sampler2D u_sprites;
uniform vec4 u_spriteRects[MAX_SPRITES]; // per-sprite atlas UV rect: [u0, v0, uWidth, vHeight]
out vec4 frag;

/* shape flags: 0 rect, 1 circle, 2 soft glow, 3 ring, 4 triangle, 5 hexagon, 6 slash */

// distance from point p to segment a-b (world space; length-based, precision-robust)
float distToSeg(vec2 p, vec2 a, vec2 b){
  vec2 ab = b - a;
  vec2 ap = p - a;
  float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(ap - ab * t);
}

// does segment A(0,0)->B cross wall segment C->D, strictly interior to A->B?
// all args are LIGHT-RELATIVE (light at origin) and highp, to avoid mediump cancellation.
bool segCross(highp vec2 B, highp vec2 C, highp vec2 D){
  highp vec2 s = D - C;
  highp float rxs = B.x * s.y - B.y * s.x;      // B is the ray A->B with A=origin
  if(abs(rxs) < 1e-6) return false;             // parallel/collinear → ignore
  highp vec2 ac = C;                            // C - A, A = origin
  highp float t = (ac.x * s.y - ac.y * s.x) / rxs;   // param along A->B
  highp float u = (ac.x * B.y - ac.y * B.x) / rxs;   // param along C->D
  const float E = 0.01;                         // endpoint guard: no caster-edge acne
  return t > E && t < 1.0 - E && u >= 0.0 && u <= 1.0;
}

// how lit a world point is: ambient + the brightest of every player's pool/cone
float lightAt(vec2 w){
  float best = 0.0;
  bool anyLOS = false;
  for(int i = 0; i < MAX_LIGHTS; i++){
    if(i >= u_lightCount) break;
    highp vec2 Lp = u_lightPos[i];
    highp vec2 d = w - Lp;
    float dist = length(d);
    float range = u_lightCone[i].y;

    // personal "feet" pool is NOT occluded (omni bubble; keeps the player's feet visible
    // even hugging a wall — occluding it makes the feet flicker to black). Count it first.
    float pool = smoothstep(u_personal.x, u_personal.x * 0.3, dist) * u_personal.y;
    best = max(best, pool);

    // occlusion: any wall between this light and w? gates the CONE only.
    bool blocked = false;
    for(int k = 0; k < MAX_WALLS; k++){
      if(k >= u_wallCount) break;
      vec4 seg = u_wall[k];
      if(distToSeg(Lp, seg.xy, seg.zw) > range) continue;         // early reject: wall beyond this light's reach
      if(segCross(d, seg.xy - Lp, seg.zw - Lp)){ blocked = true; break; }
    }
    if(blocked) continue;   // cone blocked here; pool already counted above
    anyLOS = true;

    vec2 dir = dist > 1e-3 ? d / dist : u_lightAim[i];
    float ca = dot(dir, u_lightAim[i]);
    float e = smoothstep(u_lightCone[i].x, mix(u_lightCone[i].x, 1.0, 0.35), ca);
    float reach = smoothstep(range, range * 0.25, dist);
    float cone = e * reach * u_lightInt[i];
    best = max(best, cone);
  }
  float floorLevel = anyLOS ? u_ambient : u_shadowFloor;   // any unblocked cone → gloom; behind every cone → dark
  return clamp(floorLevel + best, 0.0, 1.0);
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
  } else if(s >= 16){
    int i = s - 16;
    vec4 rc = u_spriteRects[i];
    vec2 uv;
    if(v_frag != 0.0){
      float cellIdx = v_frag - 1.0;              // 0 .. N*N-1
      float cxc = mod(cellIdx, u_gridN);
      float cyc = floor(cellIdx / u_gridN);
      vec2 cellSz = rc.zw / u_gridN;             // sub-rect size in atlas UV
      vec2 base   = rc.xy + vec2(cxc, cyc) * cellSz;
      uv = base + vec2(v_local.x + 0.5, 0.5 - v_local.y) * cellSz;
      // interior cell boundaries aren't inset by uvRect — clamp by half a texel to stop bleed
      vec2 hlf = vec2(u_atlasTexel * 0.5);
      uv = clamp(uv, base + hlf, base + cellSz - hlf);
    } else {
      uv = rc.xy + vec2(v_local.x + 0.5, 0.5 - v_local.y) * rc.zw;
    }
    vec4 t = texture(u_sprites, uv);
    if(t.a < 0.5) discard;
    frag = vec4(t.rgb, t.a) * v_color;
  } else {
    frag = v_color;
  }
  // normal pass (u_emissive 0) fully darkens; additive pass keeps a floor so
  // glows, muzzle flashes and zombie eyes still read in the dark.
  frag.rgb *= mix(u_emissive, 1.0, lightAt(v_world));
  frag.rgb = mix(vec3(dot(frag.rgb, vec3(0.2126, 0.7152, 0.0722))), frag.rgb, u_sat) * u_dim;
}
