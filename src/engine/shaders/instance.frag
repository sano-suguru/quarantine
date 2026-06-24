#version 300 es
precision mediump float;
in vec2 v_local; in vec4 v_color; in float v_shape;
out vec4 frag;
void main(){
  if(v_shape > 0.5){
    float d = length(v_local);
    if(d > 0.5) discard;
    float a = smoothstep(0.5, 0.45, d);
    float rim = smoothstep(0.5,0.30,d);
    frag = vec4(v_color.rgb * (0.7 + 0.3*rim), v_color.a * a);
  } else {
    frag = v_color;
  }
}
