#version 300 es
precision mediump float;
#define MAX_LIGHTS 4
in vec2 v_clip; uniform vec2 u_cam; uniform vec2 u_half;
uniform int u_lightCount;
uniform vec2 u_lightPos[MAX_LIGHTS];
uniform vec2 u_lightAim[MAX_LIGHTS];
uniform float u_lightInt[MAX_LIGHTS];
uniform vec3 u_cone;     // shared: x: cos(halfAngle), y: range, z: ambient floor
uniform vec2 u_personal; // shared: x: radius, y: max brightness of the dim pool
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
    float e = smoothstep(u_cone.x, mix(u_cone.x, 1.0, 0.35), ca);
    float reach = smoothstep(u_cone.y, u_cone.y * 0.25, dist);
    float cone = e * reach * u_lightInt[i];
    best = max(best, max(pool, cone));
  }
  return clamp(u_cone.z + best, 0.0, 1.0);
}
void main(){
  vec2 world = u_cam + vec2(v_clip.x, -v_clip.y) * u_half;
  float minor = gridLine(world, 80.0)  * 0.06;
  float major = gridLine(world, 400.0) * 0.10;
  vec3 base = vec3(0.027,0.039,0.031);
  vec3 col = base + vec3(0.49,1.0,0.31) * (minor+major);
  // the floor sinks to black outside the flashlight
  col *= lightAt(world);
  frag = vec4(col,1.0);
}
