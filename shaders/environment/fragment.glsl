// Base color of the lit object (whale or sea floor)
uniform vec3 baseColor;

// Colored glow applied to a whale while its sound is playing (0 = off, 1 = full)
uniform float glow;
uniform vec3 glowColor;

// Look (see `look` in index.js)
uniform float ambient;       // light everywhere
uniform float diffuse;       // extra light on surfaces facing up
uniform vec3 rimColor;       // light grazing the silhouette
uniform float rimStrength;
uniform vec3 deepColor;      // things deeper under the surface tint towards it
uniform float depthTint;
uniform float floorNoise;    // sand-like variation (sea floor only)
uniform vec3 fogColor;       // distance fog, towards the horizon
uniform float fogNear;
uniform float fogFar;
// 1 while rendering what the water refracts: only what is under the surface
// (a jumping whale's body in the air must not show through the water too).
uniform float underwaterOnly;

varying float lightIntensity;
varying vec3 worldPosition;
varying vec3 worldNormal;
varying vec3 vertexColor;

const float waterHeight = 0.1;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
             mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}

void main() {
  if (underwaterOnly > 0.5 && worldPosition.z > waterHeight) discard;

  // Ambient light + diffuse light
  float computedLightIntensity = ambient + diffuse * lightIntensity;

  vec3 albedo = baseColor * vertexColor;
  if (floorNoise > 0.) {
    // Two octaves, rotated against each other so the value-noise grid
    // doesn't show as blocks
    vec2 p = worldPosition.xy;
    float n = valueNoise(p * 3.1) * 0.6 + valueNoise(mat2(0.8, -0.6, 0.6, 0.8) * p * 9.7) * 0.4;
    albedo *= 1. + floorNoise * (n - 0.5) * 2.;
  }

  vec3 color = albedo * computedLightIntensity;

  if (rimStrength > 0.) {
    vec3 toEye = normalize(cameraPosition - worldPosition);
    float rim = pow(1. - max(dot(normalize(worldNormal), toEye), 0.), 3.);
    color += rimColor * rim * rimStrength;
  }

  // Singing whale: tint towards its own color
  color = mix(color, glowColor * computedLightIntensity * 1.4, clamp(glow, 0., 1.) * 0.85);

  float depth = clamp((waterHeight - worldPosition.z) * depthTint, 0., 1.);
  color = mix(color, deepColor, depth);

  float fog = smoothstep(fogNear, fogFar, distance(cameraPosition, worldPosition));
  color = mix(color, fogColor, fog);

  gl_FragColor = vec4(color, 1.);
}
