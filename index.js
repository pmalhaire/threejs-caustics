// Baleines — play whale songs on a caustics-lit sea.
// Rendering technique from https://github.com/martinRenou/threejs-caustics

'use strict';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const canvas = document.getElementById('canvas');
const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

// Colors
const black = new THREE.Color('black');
const seaColor = new THREE.Color('#06243f');

function loadFile(filename) {
  return new Promise((resolve, reject) => {
    new THREE.FileLoader().load(filename, resolve, undefined, reject);
  });
}

// Constants
const waterHeight = 0.1;
const waterPosition = new THREE.Vector3(0, 0, waterHeight);
// Number of segments of the water meshes (lighter on phones/tablets)
const waterSegments = isCoarsePointer ? 512 : 1024;
const simulationSize = 1024;
const envSize = 1024;
const causticsSize = 1024;
const waterScale = 4;
const floorDepth = -0.14;

// Directional light, pointing down. The camera is also used as the light
// point of view for the environment map and caustics.
const light = [0., 0., -1.];

// Camera looks at the water from above, tilted.
// Reference framing: vertical fov of 35° for a 3:2 landscape viewport.
const cameraDistance = 2.7;
// Center of the arc of whales
const cameraTarget = new THREE.Vector3(0, 0.14, waterHeight);
// A little wider than the original framing so no whale touches the edges
const refHalfV = Math.tan(THREE.MathUtils.degToRad(35 / 2)) * 1.2; // world "y" extent
const refHalfH = refHalfV * 1.5;                                      // world "x" extent

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1.5, 0.01, 100);
camera.up.set(0, 0, 1);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.autoClear = false;

// ---------------------------------------------------------------------------
// Floating point textures
//
// The water simulation, the environment map and the caustics live in floating
// point textures, and what devices report about them is not reliable: iOS
// renders to float textures it cannot filter, some Android GPUs cannot read
// them from a vertex shader, others cannot blend into them. An unusable
// texture reads as (0, 0, 0, 1): the water normal then lies flat on its side,
// the sea shows the sky reflection and the whales are refracted off screen.
//
// So every format is tested at startup exactly the way it is used: written by
// a draw call (with additive blending for the caustics), then read back from a
// vertex or fragment shader into a regular texture whose pixel we check.
// ---------------------------------------------------------------------------

const ext = (name) => !!renderer.extensions.get(name);
['OES_texture_float', 'OES_texture_half_float', 'OES_texture_float_linear',
  'OES_texture_half_float_linear', 'WEBGL_color_buffer_float',
  'EXT_color_buffer_half_float', 'EXT_color_buffer_float', 'EXT_float_blend'].forEach(ext);

const FLOAT_NEAREST = { type: THREE.FloatType, filter: THREE.NearestFilter, name: 'float/nearest' };
const HALF_NEAREST = { type: THREE.HalfFloatType, filter: THREE.NearestFilter, name: 'half/nearest' };
const FLOAT_LINEAR = { type: THREE.FloatType, filter: THREE.LinearFilter, name: 'float/linear' };
const HALF_LINEAR = { type: THREE.HalfFloatType, filter: THREE.LinearFilter, name: 'half/linear' };

function createFloatTarget(size, format, options = {}) {
  return new THREE.WebGLRenderTarget(size, size, Object.assign({
    type: format.type,
    minFilter: format.filter,
    magFilter: format.filter,
  }, options));
}

const probe = (() => {
  const quadGeometry = new THREE.PlaneBufferGeometry(2, 2);
  const passThroughVertex = 'precision highp float; attribute vec3 position;' +
    'void main() { gl_Position = vec4(position.xy, 0., 1.); }';

  const writeMaterial = new THREE.RawShaderMaterial({
    uniforms: { color: { value: new THREE.Vector4() } },
    vertexShader: passThroughVertex,
    fragmentShader: 'precision highp float; uniform vec4 color;' +
      'void main() { gl_FragColor = color; }',
  });

  const blendMaterial = writeMaterial.clone();
  blendMaterial.transparent = true;
  blendMaterial.blending = THREE.CustomBlending;
  blendMaterial.blendEquation = THREE.AddEquation;
  blendMaterial.blendSrc = THREE.OneFactor;
  blendMaterial.blendDst = THREE.OneFactor;
  blendMaterial.blendEquationAlpha = THREE.AddEquation;
  blendMaterial.blendSrcAlpha = THREE.OneFactor;
  blendMaterial.blendDstAlpha = THREE.ZeroFactor;

  // Both readers output value * (.5, .5, .5, 1) + (.5, .5, .5, 0)
  const readUniforms = () => ({ source: { value: null }, uv: { value: new THREE.Vector2() } });
  const vertexReadMaterial = new THREE.RawShaderMaterial({
    uniforms: readUniforms(),
    vertexShader: 'precision highp float; attribute vec3 position;' +
      'uniform sampler2D source; uniform vec2 uv; varying vec4 value;' +
      'void main() { value = texture2D(source, uv); gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: 'precision highp float; varying vec4 value;' +
      'void main() { gl_FragColor = value * vec4(.5, .5, .5, 1.) + vec4(.5, .5, .5, 0.); }',
  });
  const fragmentReadMaterial = new THREE.RawShaderMaterial({
    uniforms: readUniforms(),
    vertexShader: passThroughVertex,
    fragmentShader: 'precision highp float; uniform sampler2D source; uniform vec2 uv;' +
      'void main() { gl_FragColor = texture2D(source, uv) * vec4(.5, .5, .5, 1.) + vec4(.5, .5, .5, 0.); }',
  });

  const quad = new THREE.Mesh(quadGeometry, writeMaterial);
  quad.frustumCulled = false;
  const readback = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
  const pixel = new Uint8Array(4);

  function draw(target, material, color) {
    quad.material = material;
    if (color) material.uniforms['color'].value.set(...color);
    renderer.setRenderTarget(target);
    renderer.render(quad, camera);
  }

  // Read the texel of `texture` at `uv`, from a vertex or a fragment shader
  function read(texture, uv, stage) {
    const material = stage === 'vertex' ? vertexReadMaterial : fragmentReadMaterial;
    material.uniforms['source'].value = texture;
    material.uniforms['uv'].value.set(uv[0], uv[1]);
    renderer.setRenderTarget(readback);
    renderer.setClearColor(black, 0);
    renderer.clear();
    draw(readback, material);
    renderer.readRenderTargetPixels(readback, 1, 1, 1, 1, pixel);
    renderer.setRenderTarget(null);
    material.uniforms['source'].value = null;
    return Array.from(pixel);
  }

  const expected = [159, 191, 223, 255]; // (.25, .5, .75, 1) through the readers
  const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 8);

  // Does `format` work when written (optionally blended) and read from `stages`?
  function formatWorks(format, { stages, blend }) {
    const target = createFloatTarget(4, format, { depthBuffer: false });
    let works = false;
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(black, 0);
      renderer.clear();
      if (blend) {
        draw(target, blendMaterial, [.125, .25, .375, 1]);
        draw(target, blendMaterial, [.125, .25, .375, 1]);
      } else {
        draw(target, writeMaterial, [.25, .5, .75, 1]);
      }
      works = stages.every((stage) => close(read(target.texture, [.375, .375], stage), expected));
    } catch (error) {
      works = false;
    }
    renderer.setRenderTarget(null);
    target.dispose();
    return works;
  }

  function pick(candidates, needs) {
    const format = candidates.find((candidate) => formatWorks(candidate, needs));
    return format || null;
  }

  return { pick, read, formatWorks };
})();

// Water simulation: written by the simulation, read by the vertex shaders of
// the water surface and the caustics (nearest filtering, like three.js' GPGPU
// helpers, is what vertex shaders support best).
const simulationFormats = [FLOAT_NEAREST, HALF_NEAREST, FLOAT_LINEAR, HALF_LINEAR]
  .filter((format) => probe.formatWorks(format, { stages: ['vertex', 'fragment'] }));
// Environment map (positions and depths), read by the caustics vertex shader.
// Precision matters: half floats draw streaks of light on the sea floor.
const envFormat = probe.pick([FLOAT_NEAREST, HALF_NEAREST, FLOAT_LINEAR, HALF_LINEAR],
  { stages: ['vertex'] });
// Caustics: accumulated with additive blending, read (and blurred) by the
// whales and floor fragment shaders.
const causticsFormat = probe.pick([FLOAT_LINEAR, HALF_LINEAR, FLOAT_NEAREST, HALF_NEAREST],
  { stages: ['fragment'], blend: true });

const diagnostics = {
  build: 'v4',
  gpu: (() => {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  })(),
  simulation: simulationFormats.length ? simulationFormats[0].name : 'none',
  environment: envFormat ? envFormat.name : 'none',
  caustics: causticsFormat ? causticsFormat.name : 'none',
  water: 'pending',
};

// Target for computing the water refraction (resized with the canvas)
const temporaryRenderTarget = new THREE.WebGLRenderTarget(1, 1);

// Frame the whole choir of whales whatever the viewport shape.
// In portrait the camera looks at the arc from its side so it runs vertically
// on screen, with a lighter tilt to keep the far side of the sea in view.
function resize() {
  // Use the canvas' real size on the page: inside apps and iframes
  // window.innerWidth/innerHeight can be wrong, stretching the picture.
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  if (!w || !h) return;
  const aspect = w / h;
  const portrait = aspect < 1;

  let halfV;
  let tilt;
  if (portrait) {
    tilt = Math.PI / 12;
    halfV = Math.max(refHalfH, refHalfV / aspect);
    camera.position.set(cameraTarget.x - cameraDistance * Math.sin(tilt), cameraTarget.y, 0);
  } else {
    tilt = Math.PI / 6;
    halfV = Math.max(refHalfV, refHalfH / aspect);
    camera.position.set(cameraTarget.x, cameraTarget.y - cameraDistance * Math.sin(tilt), 0);
  }
  camera.position.z = waterHeight + cameraDistance * Math.cos(tilt);

  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfV));
  camera.aspect = aspect;
  camera.lookAt(cameraTarget);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  renderer.setSize(w, h, false);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  temporaryRenderTarget.setSize(size.x, size.y);

  layoutLabels();
}

// Clock
const clock = new THREE.Clock();

// Ray caster, and an invisible plane at the water surface to cast rays on
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const targetGeometry = new THREE.PlaneGeometry(waterScale, waterScale);
for (let vertex of targetGeometry.vertices) {
  vertex.z = waterPosition.z;
}
const targetMesh = new THREE.Mesh(targetGeometry);

// Geometries
const waterGeometry = new THREE.PlaneBufferGeometry(waterScale, waterScale, waterSegments, waterSegments);

// ---------------------------------------------------------------------------
// Whales, arranged in an arc
// ---------------------------------------------------------------------------

const initialPosX = 0.1;
const initialPosY = .5;
const posRangeX = 1.8;
const posRangeY = 3.0;

const whalesCount = 8;
const whales = [];
const whalesPosition = [];

// Each whale has its own color, used when it sings
const whaleColors = [
  '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c',
  '#38d9a9', '#4dabf7', '#9775fa', '#f783ac',
].map((c) => new THREE.Color(c));

const whaleBaseColor = new THREE.Color(0.0, 0.4, 1.0);
const floorBaseColor = new THREE.Color(0.05, 0.32, 0.5);

function whaleTranslateFromIndex(i) {
  // convert from [0,whalesCount[ to [-1,1]
  let posX = initialPosX + posRangeX / (whalesCount - 1) * i - 1;
  let posY = initialPosY + posRangeY / (whalesCount - 1) * i - 1;

  if (i == whalesCount / 2 - 1) {
    posX -= .05;
  } else if (i == whalesCount / 2) {
    posX += .05;
  }

  if (i >= whalesCount / 2) {
    posY = initialPosY + posRangeY / (whalesCount - 1) * ((whalesCount - 1) - i) - 1;
  }

  return { posX, posY };
}

// Loading progress (whale model + sounds)
const progress = { whale: 0, sounds: 0 };
function updateProgress() {
  const value = Math.round((progress.whale * 0.4 + progress.sounds * 0.6) * 100);
  const bar = document.getElementById('progress-bar');
  if (bar) bar.style.width = `${value}%`;
}

const objLoader = new THREE.OBJLoader();
const whalesLoaded = new Promise((resolve, reject) => {
  objLoader.load('assets/whale.obj', (whaleObject) => {
    const whaleGeometry = whaleObject.children[0].geometry;
    whaleGeometry.computeVertexNormals();
    const size = 0.0005;

    whaleGeometry.rotateZ(Math.PI / 2.);
    whaleGeometry.scale(size, size, size);

    for (let i = 0; i < whalesCount; i++) {
      const whale = whaleGeometry.clone();
      const { posX, posY } = whaleTranslateFromIndex(i);
      whale.translate(posX, posY, 0);
      whale.computeBoundingSphere();
      const { x, y, z } = whale.boundingSphere.center;
      whalesPosition.push(new THREE.Vector3(x, y, z));
      whales.push(whale);
    }
    progress.whale = 1;
    updateProgress();
    resolve();
  }, (event) => {
    if (event.lengthComputable) {
      progress.whale = event.loaded / event.total;
      updateProgress();
    }
  }, reject);
});

// Sea floor, receiving the caustics
const floorGeometry = new THREE.PlaneBufferGeometry(waterScale * 2, waterScale * 2);
floorGeometry.translate(0, 0, floorDepth);

// Sky used for the water reflections: a simple vertical gradient cube map
function createSkyTexture() {
  const size = 64;
  const faces = [];
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, size);
    gradient.addColorStop(0, '#dff3ff');
    gradient.addColorStop(1, '#7cc4e8');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    faces.push(c);
  }
  const texture = new THREE.CubeTexture(faces);
  texture.needsUpdate = true;
  return texture;
}
const skyTexture = createSkyTexture();

// ---------------------------------------------------------------------------
// Rendering passes
// ---------------------------------------------------------------------------

class WaterSimulation {

  constructor() {
    this._camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 2000);

    this._geometry = new THREE.PlaneBufferGeometry(2, 2);

    this.setFormat(simulationFormats[0] || FLOAT_NEAREST);

    const shadersPromises = [
      loadFile('shaders/simulation/vertex.glsl'),
      loadFile('shaders/simulation/drop_fragment.glsl'),
      loadFile('shaders/simulation/update_fragment.glsl'),
    ];

    this.loaded = Promise.all(shadersPromises)
      .then(([vertexShader, dropFragmentShader, updateFragmentShader]) => {
        const dropMaterial = new THREE.RawShaderMaterial({
          uniforms: {
            center: { value: [0, 0] },
            radius: { value: 0 },
            strength: { value: 0 },
            texture: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: dropFragmentShader,
        });

        const updateMaterial = new THREE.RawShaderMaterial({
          uniforms: {
            texture: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: updateFragmentShader,
        });

        this._dropMesh = new THREE.Mesh(this._geometry, dropMaterial);
        this._updateMesh = new THREE.Mesh(this._geometry, updateMaterial);
        this._dropMesh.frustumCulled = false;
        this._updateMesh.frustumCulled = false;
      });
  }

  // (Re)create the two ping-pong textures, with flat water
  setFormat(format) {
    if (this._targetA) {
      this._targetA.dispose();
      this._targetB.dispose();
    }
    this.format = format;
    this._targetA = createFloatTarget(simulationSize, format, { depthBuffer: false });
    this._targetB = createFloatTarget(simulationSize, format, { depthBuffer: false });
    this.target = this._targetA;
    this.clear();
  }

  clear() {
    const oldTarget = renderer.getRenderTarget();
    for (const target of [this._targetA, this._targetB]) {
      renderer.setRenderTarget(target);
      renderer.setClearColor(black, 0);
      renderer.clear();
    }
    renderer.setRenderTarget(oldTarget);
  }

  // Add a drop of water at the (x, y) coordinate (in the range [-1, 1])
  addDrop(renderer, x, y, radius, strength) {
    this._dropMesh.material.uniforms['center'].value = [x, y];
    this._dropMesh.material.uniforms['radius'].value = radius;
    this._dropMesh.material.uniforms['strength'].value = strength;

    this._render(renderer, this._dropMesh);
  }

  stepSimulation(renderer) {
    this._render(renderer, this._updateMesh);
  }

  _render(renderer, mesh) {
    // Swap textures
    const _oldTarget = this.target;
    const _newTarget = this.target === this._targetA ? this._targetB : this._targetA;

    const oldTarget = renderer.getRenderTarget();

    renderer.setRenderTarget(_newTarget);

    mesh.material.uniforms['texture'].value = _oldTarget.texture;

    renderer.render(mesh, this._camera);

    renderer.setRenderTarget(oldTarget);

    this.target = _newTarget;
  }

}


class Water {

  constructor() {
    this.geometry = waterGeometry;

    const shadersPromises = [
      loadFile('shaders/water/vertex.glsl'),
      loadFile('shaders/water/fragment.glsl')
    ];

    this.loaded = Promise.all(shadersPromises)
      .then(([vertexShader, fragmentShader]) => {
        this.material = new THREE.ShaderMaterial({
          uniforms: {
            light: { value: light },
            water: { value: null },
            waterStrength: { value: 1 },
            envMap: { value: null },
            skybox: { value: skyTexture },
            fadeColor: { value: seaColor },
          },
          vertexShader: vertexShader,
          fragmentShader: fragmentShader,
        });
        this.material.extensions = {
          derivatives: true
        };

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.position.set(waterPosition.x, waterPosition.y, waterPosition.z);
        this.mesh.frustumCulled = false;
      });
  }

  setHeightTexture(waterTexture) {
    this.material.uniforms['water'].value = waterTexture;
  }

  // 0 keeps the surface flat (when the simulation cannot be read)
  setWaterStrength(strength) {
    this.material.uniforms['waterStrength'].value = strength;
  }

  setEnvMapTexture(envMap) {
    this.material.uniforms['envMap'].value = envMap;
  }

}


// This renders the environment map seen from the light POV.
// The resulting texture contains (posx, posy, posz, depth) in the colors channels.
class EnvironmentMap {

  constructor() {
    this.size = envSize;
    this.target = createFloatTarget(this.size, envFormat || FLOAT_NEAREST);

    const shadersPromises = [
      loadFile('shaders/environment_mapping/vertex.glsl'),
      loadFile('shaders/environment_mapping/fragment.glsl')
    ];

    this._meshes = [];

    this.loaded = Promise.all(shadersPromises)
      .then(([vertexShader, fragmentShader]) => {
        this._material = new THREE.ShaderMaterial({
          vertexShader: vertexShader,
          fragmentShader: fragmentShader,
        });
      });
  }

  setGeometries(geometries) {
    this._meshes = geometries.map((geometry) => new THREE.Mesh(geometry, this._material));
  }

  render(renderer) {
    const oldTarget = renderer.getRenderTarget();

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(black, 0);
    renderer.clear();

    for (let mesh of this._meshes) {
      renderer.render(mesh, camera);
    }

    renderer.setRenderTarget(oldTarget);
  }

}


class Caustics {

  constructor() {
    this.target = createFloatTarget(causticsSize, causticsFormat || HALF_LINEAR);

    this._waterGeometry = new THREE.PlaneBufferGeometry(waterScale, waterScale, waterSegments, waterSegments);

    const shadersPromises = [
      loadFile('shaders/caustics/water_vertex.glsl'),
      loadFile('shaders/caustics/water_fragment.glsl'),
    ];

    this.loaded = Promise.all(shadersPromises)
      .then(([waterVertexShader, waterFragmentShader]) => {
        this._waterMaterial = new THREE.ShaderMaterial({
          uniforms: {
            light: { value: light },
            env: { value: null },
            water: { value: null },
            waterStrength: { value: 1 },
            deltaEnvTexture: { value: null },
          },
          vertexShader: waterVertexShader,
          fragmentShader: waterFragmentShader,
          transparent: true,
        });

        this._waterMaterial.blending = THREE.CustomBlending;

        // Set the blending so that:
        // Caustics intensity uses an additive function
        this._waterMaterial.blendEquation = THREE.AddEquation;
        this._waterMaterial.blendSrc = THREE.OneFactor;
        this._waterMaterial.blendDst = THREE.OneFactor;

        // Caustics depth does not use blending, we just set the value
        this._waterMaterial.blendEquationAlpha = THREE.AddEquation;
        this._waterMaterial.blendSrcAlpha = THREE.OneFactor;
        this._waterMaterial.blendDstAlpha = THREE.ZeroFactor;

        this._waterMaterial.side = THREE.DoubleSide;
        this._waterMaterial.extensions = {
          derivatives: true
        };

        this._waterMesh = new THREE.Mesh(this._waterGeometry, this._waterMaterial);
        this._waterMesh.frustumCulled = false;
      });
  }

  setDeltaEnvTexture(deltaEnvTexture) {
    this._waterMaterial.uniforms['deltaEnvTexture'].value = deltaEnvTexture;
  }

  setTextures(waterTexture, envTexture) {
    this._waterMaterial.uniforms['env'].value = envTexture;
    this._waterMaterial.uniforms['water'].value = waterTexture;
  }

  setWaterStrength(strength) {
    this._waterMaterial.uniforms['waterStrength'].value = strength;
  }

  clear() {
    const oldTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(black, 0);
    renderer.clear();
    renderer.setRenderTarget(oldTarget);
  }

  render(renderer) {
    const oldTarget = renderer.getRenderTarget();

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(black, 0);
    renderer.clear();

    renderer.render(this._waterMesh, camera);

    renderer.setRenderTarget(oldTarget);
  }

}


// Objects under the water (whales + sea floor), lit by the caustics.
// Every mesh gets its own material so each whale can glow on its own.
class Environment {

  constructor() {
    const shadersPromises = [
      loadFile('shaders/environment/vertex.glsl'),
      loadFile('shaders/environment/fragment.glsl')
    ];

    this._meshes = [];
    this.whaleMaterials = [];

    this.loaded = Promise.all(shadersPromises).then(([vertexShader, fragmentShader]) => {
      this._baseMaterial = new THREE.ShaderMaterial({
        uniforms: {
          light: { value: light },
          caustics: { value: null },
          lightProjectionMatrix: { value: camera.projectionMatrix },
          lightViewMatrix: { value: camera.matrixWorldInverse },
          baseColor: { value: whaleBaseColor },
          causticsStrength: { value: 1.0 },
          glow: { value: 0.0 },
          glowColor: { value: new THREE.Color() },
          fadeColor: { value: seaColor },
        },
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
      });
    });
  }

  _createMaterial(baseColor, causticsStrength) {
    const material = this._baseMaterial.clone();
    // Share the matrices with the camera (clone() copies them)
    material.uniforms['lightProjectionMatrix'].value = camera.projectionMatrix;
    material.uniforms['lightViewMatrix'].value = camera.matrixWorldInverse;
    material.uniforms['baseColor'].value = baseColor;
    material.uniforms['causticsStrength'].value = causticsStrength;
    material.uniforms['fadeColor'].value = seaColor;
    return material;
  }

  setGeometries(whaleGeometries, floor) {
    this._meshes = [];
    this.whaleMaterials = [];

    whaleGeometries.forEach((geometry, i) => {
      const material = this._createMaterial(whaleBaseColor, 1.0);
      material.uniforms['glowColor'].value = whaleColors[i];
      this.whaleMaterials.push(material);
      this._meshes.push(new THREE.Mesh(geometry, material));
    });

    const floorMaterial = this._createMaterial(floorBaseColor, 0.9);
    const floorMesh = new THREE.Mesh(floor, floorMaterial);
    floorMesh.frustumCulled = false;
    this._meshes.push(floorMesh);
  }

  updateCaustics(causticsTexture) {
    for (let mesh of this._meshes) {
      mesh.material.uniforms['caustics'].value = causticsTexture;
    }
  }

  setGlow(index, value) {
    this.whaleMaterials[index].uniforms['glow'].value = value;
  }

  addTo(scene) {
    for (let mesh of this._meshes) {
      scene.add(mesh);
    }
  }

}

const waterSimulation = new WaterSimulation();
const water = new Water();
const environmentMap = new EnvironmentMap();
const environment = new Environment();
const caustics = new Caustics();

// ---------------------------------------------------------------------------
// Sound — Web Audio for low latency playback, stereo placed by whale position
// ---------------------------------------------------------------------------

const soundFiles = [
  'EX_WS_perc_humpback_whale_stomp_Bb',
  'EX_WS_bass_humpback_whale_deep_C',
  'EX_WS_tone_humpback_whale_trumpet_B',
  'EX_WS_texture_humpback_whale_ambience',
  'EX_WS_tonal_humpback_whale_multiple',
  'EX_WS_tonal_humpback_whale_deep_phrase',
  'EX_WS_tone_humpback_whale_zipper_F',
  'EX_WS_clap_sperm_whale',
].map((name) => `assets/sounds/${name}.mp3`);

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioContextClass();
const masterGain = audioContext.createGain();
masterGain.gain.value = 0.9;
masterGain.connect(audioContext.destination);

// Safari < 14.1 only supports the callback version of decodeAudioData
function decodeAudio(data) {
  return new Promise((resolve, reject) => {
    const result = audioContext.decodeAudioData(data, resolve, reject);
    if (result && result.then) result.then(resolve, reject);
  });
}

const soundBuffers = new Array(whalesCount).fill(null);
let soundsDone = 0;
const soundsLoaded = Promise.all(soundFiles.map((url, i) =>
  fetch(url)
    .then((response) => response.arrayBuffer())
    .then(decodeAudio)
    .then((buffer) => { soundBuffers[i] = buffer; })
    .catch((error) => console.error('Could not load', url, error))
    .then(() => {
      soundsDone++;
      progress.sounds = soundsDone / soundFiles.length;
      updateProgress();
    })
));

// One voice per whale: singing again restarts its song (with a short fade)
const voices = new Array(whalesCount).fill(null);
// Glow of each whale, fading out after it started singing
const glowDuration = 1.6; // seconds
const glowStart = new Array(whalesCount).fill(-Infinity);
const glowLevels = new Array(whalesCount).fill(0);

function playWhale(index) {
  glowStart[index] = performance.now() / 1000;
  pulseLabel(index);

  const buffer = soundBuffers[index];
  if (!buffer) return;

  if (audioContext.state !== 'running') audioContext.resume();

  const now = audioContext.currentTime;

  const previous = voices[index];
  if (previous) {
    previous.gain.gain.cancelScheduledValues(now);
    previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
    previous.gain.gain.linearRampToValueAtTime(0, now + 0.04);
    previous.source.stop(now + 0.05);
  }

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  const gain = audioContext.createGain();
  source.connect(gain);

  let output = gain;
  if (audioContext.createStereoPanner) {
    const panner = audioContext.createStereoPanner();
    const pan = whalesPosition[index] ? THREE.MathUtils.clamp(whalesPosition[index].x, -1, 1) * 0.7 : 0;
    panner.pan.value = pan;
    gain.connect(panner);
    output = panner;
  }
  output.connect(masterGain);
  source.start(now);

  const voice = { source, gain };
  voices[index] = voice;
  source.onended = () => {
    if (voices[index] === voice) voices[index] = null;
  };
}

// ---------------------------------------------------------------------------
// Whale number labels, following the whales on screen
// ---------------------------------------------------------------------------

const labelsContainer = document.getElementById('labels');
const labels = [];

function createLabels() {
  for (let i = 0; i < whalesCount; i++) {
    const label = document.createElement('button');
    label.className = 'whale-label';
    label.textContent = i + 1;
    label.style.setProperty('--whale-color', `#${whaleColors[i].getHexString()}`);
    label.setAttribute('aria-label', `Whale ${i + 1}`);
    label.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      singWhale(i);
    });
    labelsContainer.appendChild(label);
    labels.push(label);
  }
}

function layoutLabels() {
  if (!labels.length) return;
  const rect = canvas.getBoundingClientRect();
  const offset = new THREE.Vector3();
  // Place each label just past the whale's tail (below it in landscape,
  // on its right in portrait)
  const tail = new THREE.Vector3(0, -0.26, 0);

  for (let i = 0; i < whalesCount; i++) {
    offset.copy(whalesPosition[i]).add(tail);
    offset.z = waterHeight;
    offset.project(camera);
    // Keep the labels on screen, clear of the header and the hint
    const x = THREE.MathUtils.clamp((offset.x + 1) / 2 * rect.width, 24, rect.width - 24);
    const y = THREE.MathUtils.clamp((1 - offset.y) / 2 * rect.height, 72, rect.height - 72);
    labels[i].style.left = `${rect.left + x}px`;
    labels[i].style.top = `${rect.top + y}px`;
  }
}

function pulseLabel(index) {
  const label = labels[index];
  if (!label) return;
  label.classList.remove('playing');
  // restart the css animation
  void label.offsetWidth;
  label.classList.add('playing');
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

let ready = false;

function setPointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
  pointer.y = -(event.clientY - rect.top) / rect.height * 2 + 1;
}

// Returns the point on the water surface under the pointer, if any
function waterPointUnderPointer() {
  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObject(targetMesh);
  return intersects.length ? intersects[0].point : null;
}

function closestWhale(point) {
  let closest = -1;
  let min = Infinity;
  for (let i = 0; i < whalesCount; i++) {
    const dx = whalesPosition[i].x - point.x;
    const dy = whalesPosition[i].y - point.y;
    const dist = dx * dx + dy * dy;
    if (dist < min) {
      min = dist;
      closest = i;
    }
  }
  return closest;
}

function singWhale(index) {
  if (!ready) return;
  const { x, y } = whalesPosition[index];
  waterSimulation.addDrop(renderer, x, y, 0.03, 0.02);
  playWhale(index);
}

function onPointerMove(event) {
  if (!ready) return;
  setPointerFromEvent(event);
  const point = waterPointUnderPointer();
  if (point) {
    waterSimulation.addDrop(renderer, point.x, point.y, 0.03, 0.01);
  }
}

function onPointerDown(event) {
  if (!ready) return;
  // Only the primary mouse button plays, touch and pen always do
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  setPointerFromEvent(event);
  const point = waterPointUnderPointer();
  if (!point) return;

  waterSimulation.addDrop(renderer, point.x, point.y, 0.03, 0.02);
  const index = closestWhale(point);
  if (index >= 0) playWhale(index);
}

// Physical key position (event.code) so it also works on AZERTY keyboards,
// where the top row digits need Shift.
function whaleIndexFromKey(event) {
  const match = /^(?:Digit|Numpad)([1-8])$/.exec(event.code || '');
  if (match) return parseInt(match[1], 10) - 1;
  const digit = parseInt(event.key, 10);
  if (digit >= 1 && digit <= whalesCount) return digit - 1;
  return -1;
}

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === 'f' || event.key === 'F') {
    toggleFullscreen();
    return;
  }

  const index = whaleIndexFromKey(event);
  if (index < 0 || event.repeat) return;
  event.preventDefault();
  if (!started) {
    if (!document.body.classList.contains('loaded')) return;
    start();
  }
  singWhale(index);
}

// ---------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------

const root = document.documentElement;
const fullscreenButton = document.getElementById('fullscreen');

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
  if (isFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (root.requestFullscreen) {
    root.requestFullscreen().catch(() => {});
  } else if (root.webkitRequestFullscreen) {
    root.webkitRequestFullscreen();
  }
}

if (!(root.requestFullscreen || root.webkitRequestFullscreen)) {
  // e.g. iPhone Safari
  fullscreenButton.hidden = true;
}
fullscreenButton.addEventListener('click', toggleFullscreen);
function onFullscreenChange() {
  fullscreenButton.setAttribute('aria-pressed', isFullscreen());
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// ---------------------------------------------------------------------------
// Health check: make sure the water really works on this device
// ---------------------------------------------------------------------------

let waterEnabled = true;
let causticsEnabled = !!(envFormat && causticsFormat);

// Drop some water where the probe looks, and read it back from a vertex
// shader, exactly like the water surface does. Try every usable format and,
// if none works, keep the water flat rather than showing a broken sea.
function checkWater() {
  // Texture coordinate (.375, .375) is water position (-.25, -.25)
  for (const format of simulationFormats) {
    waterSimulation.setFormat(format);
    waterSimulation.addDrop(renderer, -0.25, -0.25, 0.1, 0.5);
    const [height, , , normal] = probe.read(waterSimulation.target.texture, [.375, .375], 'vertex');
    waterSimulation.clear();
    // Expected height .5 (read as 191) and a normal component of 0 (read as 0).
    // An unreadable texture reads (0, 0, 0, 1): 128 and 255.
    if (height > 170 && normal < 64) {
      diagnostics.simulation = format.name;
      diagnostics.water = 'ok';
      return;
    }
  }
  waterEnabled = false;
  causticsEnabled = false;
  water.setWaterStrength(0);
  caustics.setWaterStrength(0);
  diagnostics.simulation = 'none';
  diagnostics.water = 'flat';
}

// The environment map center shows the sea floor, below the water (z < 0)
function checkEnvironmentMap() {
  if (!causticsEnabled) return;
  environmentMap.render(renderer);
  const [, , z, depth] = probe.read(environmentMap.target.texture, [.5, .5], 'vertex');
  if (!(z < 122 && depth > 200)) {
    causticsEnabled = false;
    diagnostics.environment += ' (unreadable)';
  }
}

function showDiagnostics() {
  const text = [diagnostics.build, diagnostics.gpu, `water ${diagnostics.simulation}`,
    `env ${diagnostics.environment}`, `caustics ${causticsEnabled ? diagnostics.caustics : 'off'}`,
    diagnostics.water].join(' \u00b7 ');
  console.info('Baleines:', text);
  const element = document.getElementById('diag');
  if (element) element.textContent = text;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function animate() {
  // Fade the whales glow
  const now = performance.now() / 1000;
  for (let i = 0; i < whalesCount; i++) {
    const level = Math.max(0, 1 - (now - glowStart[i]) / glowDuration);
    glowLevels[i] = level;
    environment.setGlow(i, level * level * (3 - 2 * level));
  }

  // Update the water (~30 simulation steps per second)
  if (clock.getElapsedTime() > 0.032) {
    if (waterEnabled) {
      waterSimulation.stepSimulation(renderer);
    }

    const waterTexture = waterSimulation.target.texture;

    water.setHeightTexture(waterTexture);

    if (causticsEnabled) {
      environmentMap.render(renderer);
      const environmentMapTexture = environmentMap.target.texture;

      caustics.setTextures(waterTexture, environmentMapTexture);
      caustics.render(renderer);
    }

    environment.updateCaustics(caustics.target.texture);

    clock.start();
  }

  // Render everything but the refractive water
  renderer.setRenderTarget(temporaryRenderTarget);
  renderer.setClearColor(seaColor, 1);
  renderer.clear();

  water.mesh.visible = false;
  renderer.render(scene, camera);

  water.setEnvMapTexture(temporaryRenderTarget.texture);

  // Then render the final scene with the refractive water
  renderer.setRenderTarget(null);
  renderer.setClearColor(seaColor, 1);
  renderer.clear();

  water.mesh.visible = true;
  renderer.render(scene, camera);

  window.requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const intro = document.getElementById('intro');
const startButton = document.getElementById('start');

let started = false;

function start() {
  if (started) return;
  started = true;
  // Browsers only allow sound after a user gesture
  audioContext.resume();
  document.body.classList.add('started');
  intro.setAttribute('aria-hidden', 'true');
  // Welcome splash
  waterSimulation.addDrop(renderer, 0, 0.2, 0.08, 0.03);
  canvas.focus();
}

const loaded = [
  waterSimulation.loaded,
  water.loaded,
  environmentMap.loaded,
  environment.loaded,
  caustics.loaded,
  whalesLoaded,
];

Promise.all(loaded).then(() => {
  environmentMap.setGeometries([...whales, floorGeometry]);
  environment.setGeometries(whales, floorGeometry);

  environment.addTo(scene);

  scene.add(water.mesh);

  caustics.setDeltaEnvTexture(1. / environmentMap.size);

  createLabels();
  resize();

  checkWater();
  checkEnvironmentMap();
  caustics.clear();
  showDiagnostics();

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);

  ready = true;
  document.body.classList.add('scene-ready');

  animate();

  return soundsLoaded;
}).then(() => {
  document.body.classList.add('loaded');
  startButton.disabled = false;
  startButton.textContent = startButton.dataset.label;
  startButton.addEventListener('click', start);
  startButton.focus();
}).catch((error) => {
  console.error(error);
  document.body.classList.add('error');
  startButton.textContent = 'Could not start: WebGL may be unavailable';
});
