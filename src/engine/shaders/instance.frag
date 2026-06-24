#version 300 es
precision mediump float;
in vec2 v_local; in vec4 v_color; in float v_shape; in vec2 v_world;
uniform vec2 u_player; uniform float u_light;
out vec4 frag;

/* shape flags: 0 rect, 1 circle, 2 soft glow, 3 ring, 4 triangle, 5 hexagon */

// darkness falloff away from the player's light
float lit(vec2 w){
  float d = distance(w, u_player);
  float f = smoothstep(u_light, u_light * 0.4, d);
  return mix(0.16, 1.0, f);
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
  } else {
    frag = v_color;
  }
  frag.rgb *= lit(v_world);
}
