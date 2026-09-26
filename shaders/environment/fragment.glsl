uniform sampler2D caustics;

// Base color of the lit object (whale or sea floor)
uniform vec3 baseColor;
// How much light the caustics add on this object
uniform float causticsStrength;

// Colored glow applied to a whale while its sound is playing (0 = off, 1 = full)
uniform float glow;
uniform vec3 glowColor;

varying float lightIntensity;
varying vec3 lightPosition;
varying vec3 worldPosition;

// The sea floor fades into the deep sea color far from the whales, which also
// hides the edges of the simulated water surface.
uniform vec3 fadeColor;

const float bias = 0.001;

const vec2 resolution = vec2(1024.);

// 5-tap separable gaussian blur (weights/offsets of a 9-tap kernel using
// linear sampling, see https://rastergrid.com/blog/2010/09/efficient-gaussian-blur-with-linear-sampling/)
float blur(sampler2D image, vec2 uv, vec2 resolution, vec2 direction) {
  float intensity = 0.;
  vec2 off1 = vec2(1.3846153846) * direction;
  vec2 off2 = vec2(3.2307692308) * direction;
  intensity += texture2D(image, uv).x * 0.2270270270;
  intensity += texture2D(image, uv + (off1 / resolution)).x * 0.3162162162;
  intensity += texture2D(image, uv - (off1 / resolution)).x * 0.3162162162;
  intensity += texture2D(image, uv + (off2 / resolution)).x * 0.0702702703;
  intensity += texture2D(image, uv - (off2 / resolution)).x * 0.0702702703;
  return intensity;
}

void main() {
  // Ambient light + diffuse light
  float computedLightIntensity = 0.5 + 0.2 * lightIntensity;

  // Retrieve caustics depth information
  float causticsDepth = texture2D(caustics, lightPosition.xy).w;

  if (causticsDepth > lightPosition.z - bias) {
    // Percentage Close Filtering
    float causticsIntensity = 0.5 * (
      blur(caustics, lightPosition.xy, resolution, vec2(0., 0.5)) +
      blur(caustics, lightPosition.xy, resolution, vec2(0.5, 0.))
    );

    computedLightIntensity += causticsStrength * causticsIntensity * smoothstep(0., 1., lightIntensity);
  }

  vec3 color = baseColor * computedLightIntensity;

  // Singing whale: tint towards its own color, keeping the caustics shimmer
  color = mix(color, glowColor * computedLightIntensity * 1.4, clamp(glow, 0., 1.) * 0.85);

  float fade = smoothstep(1.35, 2.0, length(worldPosition.xy));
  color = mix(color, fadeColor, fade);

  gl_FragColor = vec4(color, 1.);
}
