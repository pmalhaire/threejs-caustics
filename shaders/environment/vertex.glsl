uniform vec3 light;

// Light projection matrix
uniform mat4 lightProjectionMatrix;
uniform mat4 lightViewMatrix;

varying float lightIntensity;
varying vec3 lightPosition;

const float waterSize = 1.0;

// transform coods from [-1.,1] to [0, waterSize]
vec3 transformCoords(vec3 v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

void main(void){
  lightIntensity = - dot(light, normalize(normal));

  // Compute position in the light coordinates system, this will be used for
  // comparing fragment depth with the caustics texture
  vec4 lightRelativePosition = lightProjectionMatrix * lightViewMatrix * modelMatrix * vec4(position, 1.);
  lightPosition = transformCoords(lightRelativePosition.xyz / lightRelativePosition.w);

  // The position of the vertex
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}
