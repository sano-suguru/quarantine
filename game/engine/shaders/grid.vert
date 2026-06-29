#version 300 es
layout(location=0) in vec2 a_p;
out vec2 v_clip;
void main(){ v_clip=a_p; gl_Position=vec4(a_p,0.0,1.0); }
