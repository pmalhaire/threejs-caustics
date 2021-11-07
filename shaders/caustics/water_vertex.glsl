uniform vec3 light;

uniform sampler2D water;
uniform sampler2D env;
uniform float deltaEnvTexture;

varying vec3 oldPosition;
varying vec3 newPosition;
varying float waterDepth;
varying float depth;

// Air refractive index / Water refractive index
const float eta = 0.7504;

// TODO Make this a uniform
// This is the maximum iterations when looking for the ray intersection with the environment,
// if after this number of attempts we did not find the intersection, the result will be wrong.
const int MAX_ITERATIONS = 50;

// water height convert to uniform
const float waterHeight = 0.1;

const float waterSize = 1.0;

// transform coods from [-1.,1] to [0, waterSize]
vec2 transformCoords(vec2 v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

float transformCoords(float v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

void main() {
  vec4 waterInfo = texture2D(water, transformCoords(position.xy));

  // The water position is the vertex position on which we apply the height-map
  vec3 waterPosition = vec3(position.xy, position.z + waterInfo.r + waterHeight);
  vec3 waterNormal = normalize(vec3(waterInfo.b, sqrt(1.0 - dot(waterInfo.ba, waterInfo.ba)), waterInfo.a)).xzy;

  // This is the initial position: the ray starting point
  oldPosition = waterPosition;

  // Compute water coordinates in the screen space
  vec4 projectedWaterPosition = projectionMatrix * viewMatrix * vec4(waterPosition, 1.);

  vec2 currentPosition = projectedWaterPosition.xy;

  vec2 coords = transformCoords(currentPosition);

  vec3 refracted = refract(light, waterNormal, eta);
  vec4 projectedRefractionVector = projectionMatrix * viewMatrix * vec4(refracted, 1.);

  vec3 refractedDirection = projectedRefractionVector.xyz;

  waterDepth = transformCoords( projectedWaterPosition.z / projectedWaterPosition.w);
  float currentDepth = projectedWaterPosition.z;
  vec4 environment = texture2D(env, coords);

  // This factor will scale the delta parameters so that we move from one pixel to the other in the env map
  float factor = deltaEnvTexture / length(refractedDirection.xy);

  vec2 deltaDirection = refractedDirection.xy * factor;
  float deltaDepth = refractedDirection.z * factor;

  for (int i = 0; i < MAX_ITERATIONS; i++) {
    // Move the coords in the direction of the refraction
    currentPosition += deltaDirection;
    currentDepth += deltaDepth;

    // End of loop condition: The ray has hit the environment
    if (environment.w <= currentDepth) {
      break;
    }

    environment = texture2D(env, transformCoords(currentPosition));
  }

  newPosition = environment.xyz;

  vec4 projectedEnvPosition = projectionMatrix * viewMatrix * vec4(newPosition, 1.0);
  depth = transformCoords(projectedEnvPosition.z / projectedEnvPosition.w);

  gl_Position = projectedEnvPosition;
}
