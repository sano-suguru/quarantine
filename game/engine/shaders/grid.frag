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
// matches instance.frag: ambient + the brightest of every player's pool/cone
float lightAt(vec2 w){
  float best = 0.0;
  for(int i = 0; i < MAX_LIGHTS; i++){
    if(i >= u_lightCount) break;
    vec2 d = w - u_lightPos[i];
    float dist = length(d);
    float pool = smoothstep(u_personal.x, u_personal.x * 0.3, dist) * u_personal.y;
    vec2 dir = dist > 1e-3 ? d / dist : u_lightAim[i];
    float ca = dot(dir, u_lightAim[i]);
    float e = smoothstep(u_lightCone[i].x, mix(u_lightCone[i].x, 1.0, 0.35), ca);
    float reach = smoothstep(u_lightCone[i].y, u_lightCone[i].y * 0.25, dist);
    float cone = e * reach * u_lightInt[i];
    best = max(best, max(pool, cone));
  }
  return clamp(u_ambient + best, 0.0, 1.0);
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
