uniform vec3 light;

// Light projection matrix
uniform mat4 lightProjectionMatrix;
uniform mat4 lightViewMatrix;

varying float lightIntensity;
varying vec3 lightPosition;
varying vec3 worldPosition;

const float waterSize = 1.0;

#include <skinning_pars_vertex>

// transform coods from [-1.,1] to [0, waterSize]
vec3 transformCoords(vec3 v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

void main(void){
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>

  vec4 skinnedPosition = vec4(transformed, 1.);
  vec3 skinnedNormal = objectNormal;

  worldPosition = (modelMatrix * skinnedPosition).xyz;

  lightIntensity = - dot(light, normalize(skinnedNormal));

  // Compute position in the light coordinates system, this will be used for
  // comparing fragment depth with the caustics texture
  vec4 lightRelativePosition = lightProjectionMatrix * lightViewMatrix * modelMatrix * skinnedPosition;
  lightPosition = transformCoords(lightRelativePosition.xyz / lightRelativePosition.w);

  // The position of the vertex
  gl_Position = projectionMatrix * modelViewMatrix * skinnedPosition;
}
