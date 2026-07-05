#version 300 es
precision mediump float;
#define MAX_LIGHTS 8
in vec2 v_clip; uniform vec2 u_cam; uniform vec2 u_half;
uniform int u_lightCount;
uniform vec2 u_lightPos[MAX_LIGHTS];
uniform vec2 u_lightAim[MAX_LIGHTS];
uniform float u_lightInt[MAX_LIGHTS];
uniform vec2 u_lightCone[MAX_LIGHTS];  // per-light: x = cos(halfAngle), y = range
#define MAX_WALLS 32
uniform vec4 u_wall[MAX_WALLS]; // static wall segments (x1,y1,x2,y2), world space
uniform int u_wallCount;
uniform float u_shadowFloor;    // floor brightness where occluded from every light (phase-blended, set CPU-side)
uniform int u_occludeFloor;     // runtime perf fallback: 0 = skip floor occlusion (wired in Task 4)
uniform float u_ambient; // shared ambient light floor
uniform vec2 u_personal; // shared: x: radius, y: max brightness of the dim pool
uniform float u_sat; // grade: 1 = full colour, 0 = greyscale
uniform float u_dim; // grade: 1 = normal brightness, 0 = black
out vec4 frag;
float gridLine(vec2 w, float g){
  vec2 a = abs(fract(w/g - 0.5) - 0.5) / fwidth(w/g);
  float l = min(a.x,a.y);
  return 1.0 - min(l,1.0);
}

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
    if(u_occludeFloor == 1){
      for(int k = 0; k < MAX_WALLS; k++){
        if(k >= u_wallCount) break;
        vec4 seg = u_wall[k];
        if(distToSeg(Lp, seg.xy, seg.zw) > range) continue;         // early reject: wall beyond this light's reach
        if(segCross(d, seg.xy - Lp, seg.zw - Lp)){ blocked = true; break; }
      }
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
void main(){
  vec2 world = u_cam + vec2(v_clip.x, -v_clip.y) * u_half;
  float minor = gridLine(world, 80.0)  * 0.06;
  float major = gridLine(world, 400.0) * 0.10;
  vec3 base = vec3(0.05,0.065,0.055);
  vec3 col = base + vec3(0.49,1.0,0.31) * (minor+major);
  // the floor dims toward black outside the flashlight (base kept low so it stays the darkest
  // surface — walls/enemies out-of-cone read as lighter silhouettes against it)
  col *= lightAt(world);
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, u_sat) * u_dim;
  frag = vec4(col,1.0);
}
