#version 300 es
precision highp float; // REQUIRED: u_time grows unbounded; mediump breaks sin/noise in minutes
in vec2 v_clip;        // NDC ~[-1,1] over the visible screen
uniform float u_blood; // 0 (full HP) .. 1 (death): the HP creep
uniform float u_pulse; // 0..1 heartbeat throb (folded-in #dread-pulse); 0 above lowHp
uniform float u_time;  // churn/breathe clock (0 when prefers-reduced-motion)
uniform vec2  u_half;  // world half-extent → aspect = u_half.x / u_half.y
out vec4 outColor;

float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){ // 3 octaves, fixed (no u_blood-dependent branching → no GPU divergence)
  float s = 0.0, amp = 0.5;
  for(int i = 0; i < 3; i++){ s += amp * vnoise(p); p *= 2.0; amp *= 0.5; }
  return s;
}

void main(){
  float aspect = u_half.x / max(u_half.y, 1e-3);
  vec2 nc = vec2(v_clip.x * aspect, v_clip.y);      // aspect-corrected so blobs aren't stretched
  float edge = max(abs(v_clip.x), abs(v_clip.y));   // 0 center → 1 screen edge (rectangular hug)

  // one domain-warp step, drifting with time → organic, non-radial, churning boundary
  vec2 wc = nc * 2.5 + vec2(fbm(nc * 1.7 + u_time * 0.05), u_time * 0.15);
  float n = fbm(wc);
  float warpedEdge = edge + (n - 0.5) * 0.35;

  // creep: higher drive pushes the blood further in. HP + a heartbeat throb push, one layer.
  float drive = clamp(u_blood + u_pulse * 0.35, 0.0, 1.0);
  float threshold = mix(1.05, 0.35, drive);
  float shape = smoothstep(threshold, threshold + 0.35, warpedEdge);

  float breathe = 1.0 + 0.14 * sin(u_time * 3.14159); // undulation (static when u_time==0)
  vec3 bloodCol = mix(vec3(0.55, 0.0, 0.0), vec3(0.75, 0.06, 0.06), n); // arterial, varied
  float a = clamp(shape * drive * breathe, 0.0, 0.85);
  outColor = vec4(bloodCol, a);
}
