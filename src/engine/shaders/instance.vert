#version 300 es
layout(location=0) in vec2 a_quad;
layout(location=1) in vec2 a_pos;
layout(location=2) in vec2 a_scale;
layout(location=3) in float a_rot;
layout(location=4) in vec4 a_color;
layout(location=5) in float a_shape;
uniform vec2 u_cam; uniform vec2 u_half;
out vec2 v_local; out vec4 v_color; out float v_shape;
void main(){
  float c=cos(a_rot), s=sin(a_rot);
  vec2 p = a_quad * a_scale;
  vec2 r = vec2(p.x*c - p.y*s, p.x*s + p.y*c);
  vec2 world = a_pos + r;
  vec2 clip = (world - u_cam) / u_half;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_local=a_quad; v_color=a_color; v_shape=a_shape;
}
