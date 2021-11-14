uniform sampler2D caustics;
// use the playingWhalePos to change the color of the playing whale
uniform vec3 playingWhalePos;
uniform float rand;

varying float lightIntensity;
varying vec3 lightPosition;

const float bias = 0.001;

const vec3 underwaterColor = vec3(0.0, 0.4, 1.0);

const vec2 resolution = vec2(1024.);

float blur(sampler2D image, vec2 uv, vec2 resolution, vec2 direction) {
  float intensity = 0.;
  vec2 off1 = vec2(1.3846153846) * direction;
  vec2 off2 = vec2(3.2307692308) * direction;
  intensity += texture2D(image, uv).x * 0.2270270270;
  // TODO explain those hard coded values
  intensity += texture2D(image, uv + (off1 / resolution)).x * 0.3162162162;
  intensity += texture2D(image, uv - (off1 / resolution)).x * 0.3162162162;
  intensity += texture2D(image, uv + (off2 / resolution)).x * 0.0702702703;
  intensity += texture2D(image, uv - (off2 / resolution)).x * 0.0702702703;
  return intensity;
}

void main() {
  // Set the frag color
  float computedLightIntensity = 0.5;

  // TODO explain those hard coded values
  computedLightIntensity += 0.2 * lightIntensity;

  // Retrieve caustics depth information
  float causticsDepth = texture2D(caustics, lightPosition.xy).w;

  if (causticsDepth > lightPosition.z - bias) {
    // Percentage Close Filtering
    float causticsIntensity = 0.5 * (
      blur(caustics, lightPosition.xy, resolution, vec2(0., 0.5)) +
      blur(caustics, lightPosition.xy, resolution, vec2(0.5, 0.))
    );

    computedLightIntensity += causticsIntensity * smoothstep(0., 1., lightIntensity);;
  }

  gl_FragColor = vec4(underwaterColor * computedLightIntensity, 1.);


  // experimental color change of playing whale
  float distFromPlayingWhale = abs(distance(playingWhalePos, lightPosition));
  if ( distFromPlayingWhale < .6 ){
    // meta random
    if (fract(rand*1000000.0) > 0.5) {
       // red more
      gl_FragColor.r += rand * (1.0 - distFromPlayingWhale/.6);
      gl_FragColor.g -= 1.0 - distFromPlayingWhale/.6;
    } else {
      // green more
      gl_FragColor.g += rand * (1.0 - distFromPlayingWhale/.6);
      gl_FragColor.r -= 1.0 - distFromPlayingWhale/.6;
    }
    gl_FragColor.b -= 1.0 - distFromPlayingWhale/.6;
  }

}
