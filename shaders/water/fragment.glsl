uniform sampler2D envMap;
uniform samplerCube skybox;

// Look (see `look` in index.js)
uniform float reflectionMax;  // how much of the sky the surface can reflect
uniform vec3 waterTint;       // colour of the water itself, over what it shows
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
// The outer (flat, coarse) sea around the simulated square leaves a hole of
// this half size where the detailed surface is; 0 for the detailed one.
uniform float holeHalfSize;

varying vec2 refractedPosition[3];
varying vec3 reflected;
varying float reflectionFactor;
varying vec2 surfacePosition;
varying vec3 surfaceWorldPosition;

// Plain deep water colour
uniform vec3 deepWater;

const float waterSize = 1.0;

// transform coods from [-1.,1] to [0, waterSize]
vec2 transformCoords(vec2 v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

// Refracted rays can leave the rendered image near its edges: mirror them
// back inside instead of clamping (clamping smeared the edge pixels into
// rainbow streaks, one per colour channel).
vec2 mirrored(vec2 uv) {
  return 1. - abs(mod(uv, 2.) - 1.);
}

void main() {
  if (max(abs(surfacePosition.x), abs(surfacePosition.y)) < holeHalfSize) discard;

  // Color coming from the sky reflection
  vec3 reflectedColor = textureCube(skybox, reflected).xyz;

  // Color coming from the environment refraction, applying chromatic aberration
  vec3 refractedColor = vec3(1.);
  refractedColor.r = texture2D(envMap, mirrored(transformCoords(refractedPosition[0]))).r;
  refractedColor.g = texture2D(envMap, mirrored(transformCoords(refractedPosition[1]))).g;
  refractedColor.b = texture2D(envMap, mirrored(transformCoords(refractedPosition[2]))).b;
  refractedColor *= waterTint;

  vec3 color = mix(refractedColor, reflectedColor, clamp(reflectionFactor, 0., reflectionMax));

  float fog = smoothstep(fogNear, fogFar, distance(cameraPosition, surfaceWorldPosition));
  gl_FragColor = vec4(mix(color, fogColor, fog), 1.);
}
