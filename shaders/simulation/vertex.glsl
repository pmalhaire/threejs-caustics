attribute vec3 position;
varying vec2 coord;


const float waterSize = 1.0;

// transform coods from [-1.,1] to [0, waterSize]
vec2 transformCoords(vec2 v){
  return waterSize * 0.5 + waterSize * 0.5 * v;
}



void main() {
  coord = transformCoords(position.xy);

  gl_Position = vec4(position.xyz, 1.0);
}
