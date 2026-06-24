#version 300 es
precision mediump float;
in vec2 v_clip; uniform vec2 u_cam; uniform vec2 u_half;
out vec4 frag;
float gridLine(vec2 w, float g){
  vec2 a = abs(fract(w/g - 0.5) - 0.5) / fwidth(w/g);
  float l = min(a.x,a.y);
  return 1.0 - min(l,1.0);
}
void main(){
  vec2 world = u_cam + vec2(v_clip.x, -v_clip.y) * u_half;
  float minor = gridLine(world, 80.0)  * 0.06;
  float major = gridLine(world, 400.0) * 0.10;
  vec3 base = vec3(0.027,0.039,0.031);
  vec3 col = base + vec3(0.49,1.0,0.31) * (minor+major);
  frag = vec4(col,1.0);
}
