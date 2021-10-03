uniform sampler2D water;

varying vec2 refractedPosition[3];
varying vec3 reflected;
varying float reflectionFactor;

const float refractionFactor = 1.;

const float fresnelBias = 0.1;
const float fresnelPower = 2.;
const float fresnelScale = 1.;

// Air refractive index / Water refractive index
const float eta = 0.7504;

const float waterSize = 1.0;

// transform coods from [-1.,1] to [0, waterSize]
vec2 transformCoords(vec2 v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

void main() {
  vec4 info = texture2D(water, transformCoords(position.xy));

  // The water position is the vertex position on which we apply the height-map
  vec3 pos = vec3(position.xy, position.z + info.r);
  vec3 norm = normalize(vec3(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a)).xzy;

  vec3 eye = normalize(pos - cameraPosition);
  vec3 refracted = normalize(refract(eye, norm, eta));
  reflected = normalize(reflect(eye, norm));

  reflectionFactor = fresnelBias + fresnelScale * pow(1. + dot(eye, norm), fresnelPower);

  mat4 proj = projectionMatrix * modelViewMatrix;

  vec4 projectedRefractedPosition = proj * vec4(pos + refractionFactor * refracted, 1.0);
  refractedPosition[0] = projectedRefractedPosition.xy / projectedRefractedPosition.w;

  projectedRefractedPosition = proj * vec4(pos + refractionFactor * normalize(refract(eye, norm, eta * 0.96)), 1.0);
  refractedPosition[1] = projectedRefractedPosition.xy / projectedRefractedPosition.w;

  projectedRefractedPosition = proj * vec4(pos + refractionFactor * normalize(refract(eye, norm, eta * 0.92)), 1.0);
  refractedPosition[2] = projectedRefractedPosition.xy / projectedRefractedPosition.w;

  gl_Position = proj * vec4(pos, 1.0);
}
