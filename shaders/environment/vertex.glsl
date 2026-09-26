uniform vec3 light;

varying float lightIntensity;
varying vec3 worldPosition;
varying vec3 worldNormal;
// Per-vertex colour painted by the rigging pipeline (white when unused)
varying vec3 vertexColor;

#include <skinning_pars_vertex>

void main(void){
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>

  vec4 skinnedPosition = vec4(transformed, 1.);

  #ifdef USE_COLOR
    vertexColor = color;
  #else
    vertexColor = vec3(1.);
  #endif

  worldPosition = (modelMatrix * skinnedPosition).xyz;
  // World space (uniform scale only), so the light stays above the whale
  // whichever way it swims.
  worldNormal = normalize(mat3(modelMatrix) * objectNormal);

  lightIntensity = - dot(light, worldNormal);

  // The position of the vertex
  gl_Position = projectionMatrix * modelViewMatrix * skinnedPosition;
}
