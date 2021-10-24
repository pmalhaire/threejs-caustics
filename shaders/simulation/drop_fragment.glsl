precision highp float;
precision highp int;

const float PI = 3.1415926535897932384626433832795;
uniform sampler2D texture;
uniform vec2 center;
uniform float radius;
uniform float strength;
varying vec2 coord;


const float waterSize = 1.0;

// transform coods from [-1.,1] to [0, waterSize]
vec2 transformCoords(vec2 v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

float transformCoords(float v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}

void main() {
  /* Get vertex info */
  vec4 info = texture2D(texture, coord);

  /* Add the drop to the height */
  float drop = max(0.0, 1.0 - length(transformCoords(center) - coord) / radius);
  drop = transformCoords(-cos(drop * PI));
  info.r += drop * strength;

  gl_FragColor = info;
}
