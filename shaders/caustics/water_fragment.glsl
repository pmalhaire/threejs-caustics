// TODO Make it a uniform
const float causticsFactor = 0.15;

varying vec3 oldPosition;
varying vec3 newPosition;
varying float waterDepth;
varying float depth;


void main() {
  float causticsIntensity = 0.;

  if (depth >= waterDepth) {
    float oldArea = length(dFdx(oldPosition)) * length(dFdy(oldPosition));
    float newArea = length(dFdx(newPosition)) * length(dFdy(newPosition));

    // Light concentration: how much the refracted triangle shrank.
    // Bounded, so degenerate (zero area) triangles cannot produce infinite
    // light: with half float textures (iOS) position precision is low and
    // this showed as bright streaks.
    const float maxRatio = 20.;
    float ratio = newArea > oldArea / maxRatio ? oldArea / newArea : maxRatio;

    causticsIntensity = causticsFactor * ratio;
  }

  gl_FragColor = vec4(causticsIntensity, 0., 0., depth);
}
