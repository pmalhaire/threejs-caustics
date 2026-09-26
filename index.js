// Baleines — play whale songs in the deep sea.
// Water simulation and refraction from https://github.com/martinRenou/threejs-caustics

'use strict';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const canvas = document.getElementById('canvas');
const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

// ?capture: keeps the last frame readable (canvas.toDataURL) and lightens the
// water mesh, for automated screenshots.
const captureMode = new URLSearchParams(location.search).has('capture');

// Colors
const black = new THREE.Color('black');

// ---------------------------------------------------------------------------
// Look: open ocean at dusk — dark water, whales lit from above with a cold
// rim, drifting marine snow, light shafts from the surface (CSS, index.html).
// ---------------------------------------------------------------------------

const hexColor = (hex) => new THREE.Color(hex);

const look = {
  // Camera tilt from the vertical (landscape, portrait), distance to the
  // target, and zoom on the reference framing (landscape, portrait).
  camera: { tilt: [46, 40], distance: 2.4, zoom: [0.9, 0.66] },
  // Whales keep the species colours painted by the rigging pipeline.
  whaleColor: new THREE.Color(1.1, 1.1, 1.15),
  floorColor: hexColor('#08223a'),
  ambient: 0.45, diffuse: 0.8,
  rim: 0.9, rimColor: hexColor('#5fb8ff'),
  depthTint: 1.2, deepColor: hexColor('#021223'),
  floorNoise: 0.18,
  // Distance fog towards the horizon (from, to), also the background.
  fog: [2.2, 4.0], fogColor: hexColor('#021223'),
  // Where refracted rays find nothing to show.
  deepWater: hexColor('#04203a'),
  sky: ['#1b4d73', '#051a2e'],
  refraction: 0.3, dispersion: 0.25, reflectionMax: 0.25, waterTint: hexColor('#a9cdee'),
  snowOpacity: 0.55,
};

function loadFile(filename) {
  return new Promise((resolve, reject) => {
    new THREE.FileLoader().load(filename, resolve, undefined, reject);
  });
}

// Constants
const waterHeight = 0.1;
const waterPosition = new THREE.Vector3(0, 0, waterHeight);
// Number of segments of the water meshes (lighter on phones/tablets)
const waterSegments = captureMode ? 256 : isCoarsePointer ? 512 : 1024;
const simulationSize = 1024;
const waterScale = 4;
const floorDepth = -0.14;

// Directional light, pointing down (from the surface).
const light = [0., 0., -1.];

// Camera looks at the water from above, tilted.
// Reference framing: vertical fov of 35° for a 3:2 landscape viewport.
// Center of the arc of whales
const cameraTarget = new THREE.Vector3(0, 0.14, waterHeight);
// A little wider than the original framing so no whale touches the edges
const refHalfV = Math.tan(THREE.MathUtils.degToRad(35 / 2)) * 1.3; // world "y" extent
const refHalfH = refHalfV * 1.5;                                      // world "x" extent

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1.5, 0.01, 100);
camera.up.set(0, 0, 1);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: captureMode });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.autoClear = false;
console.info('Baleines: floatVertexTextures =', renderer.capabilities.floatVertexTextures);

// ---------------------------------------------------------------------------
// Floating point textures
//
// The water simulation lives in floating point textures, and what devices
// report about them is not reliable: iOS renders to float textures it cannot
// filter, some Android GPUs cannot read them from a vertex shader. An unusable
// texture reads as (0, 0, 0, 1): the water normal then lies flat on its side,
// the sea shows the sky reflection and the whales are refracted off screen.
//
// So every format is tested at startup exactly the way it is used: written by
// a draw call, then read back from a vertex or fragment shader into a regular
// texture whose pixel we check.
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

  // Does `format` work when written and read from `stages`?
  function formatWorks(format, { stages }) {
    const target = createFloatTarget(4, format, { depthBuffer: false });
    let works = false;
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(black, 0);
      renderer.clear();
      draw(target, writeMaterial, [.25, .5, .75, 1]);
      works = stages.every((stage) => close(read(target.texture, [.375, .375], stage), expected));
    } catch (error) {
      works = false;
    }
    renderer.setRenderTarget(null);
    target.dispose();
    return works;
  }

  return { read, formatWorks };
})();

// Water simulation: written by the simulation, read by the vertex shader of
// the water surface (nearest filtering, like three.js' GPGPU helpers, is what
// vertex shaders support best).
const simulationFormats = [FLOAT_NEAREST, HALF_NEAREST, FLOAT_LINEAR, HALF_LINEAR]
  .filter((format) => probe.formatWorks(format, { stages: ['vertex', 'fragment'] }));
const diagnostics = {
  build: 'v5',
  gpu: (() => {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  })(),
  simulation: simulationFormats.length ? simulationFormats[0].name : 'none',
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

  // Tilt from the vertical and distance come from the look: the lower the
  // camera, the more perspective (and horizon) the sea gets.
  const { tilt: tilts, distance, zoom: zooms } = look.camera;
  const tilt = THREE.MathUtils.degToRad(portrait ? tilts[1] : tilts[0]);
  const zoom = portrait ? zooms[1] : zooms[0];
  let halfV;
  if (portrait) {
    halfV = Math.max(refHalfH, refHalfV / aspect);
    camera.position.set(cameraTarget.x - distance * Math.sin(tilt), cameraTarget.y, 0);
  } else {
    halfV = Math.max(refHalfV, refHalfH / aspect);
    camera.position.set(cameraTarget.x, cameraTarget.y - distance * Math.sin(tilt), 0);
  }
  halfV *= zoom;
  camera.position.z = waterHeight + distance * Math.cos(tilt);

  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfV));
  camera.aspect = aspect;
  camera.lookAt(cameraTarget);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  renderer.setSize(w, h, false);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  temporaryRenderTarget.setSize(size.x, size.y);

  updateSwimArea(w, h);
}

// The part of the sea the whales may swim in: the screen minus the top bar
// and the pads (and hint above them) at the bottom, projected onto the water.
let swimArea = null;
// Ripples only exist on the simulated water, the [-1, 1] square: keep the
// whales around it (a little over, their splashes still show near the edge).
const swimRadius = 1.2;
const waterPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -waterHeight);

function updateSwimArea(w, h) {
  const top = 72;
  let padsTop = h - 140;
  for (const element of [document.getElementById('labels'), document.querySelector('.hint')]) {
    const rect = element && element.getBoundingClientRect();
    if (rect && rect.height) padsTop = Math.min(padsTop, rect.top);
  }
  const bottom = Math.min(h - 72, padsTop - 12);
  // Wide enough that a whale turning at the edge stays fully on screen.
  const side = Math.max(24, w * 0.09);
  const corners = [[side, top], [w - side, top], [w - side, bottom], [side, bottom]];
  let area = [];
  const hit = new THREE.Vector3();
  const ndc = new THREE.Vector2();
  for (const [px, py] of corners) {
    // With a low camera the top of the screen can look above the horizon:
    // slide down until the ray meets the water.
    let y = py;
    let found = false;
    for (; y <= bottom && !found; y += h * 0.04) {
      ndc.set(px / w * 2 - 1, -y / h * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      found = !!raycaster.ray.intersectPlane(waterPlane, hit);
    }
    if (!found) return; // keep the previous area
    area.push({ x: hit.x, y: hit.y });
  }
  // Only the middle of the sea is simulated and lit, it fades out beyond:
  // keep the whales inside that disc (the far side of a low camera's view
  // would otherwise stretch towards the horizon).
  const radius = swimRadius;
  area = clipPolygon(area, Array.from({ length: 24 }, (_, i) => ({
    x: radius * Math.cos(i / 24 * Math.PI * 2),
    y: radius * Math.sin(i / 24 * Math.PI * 2),
  })));
  if (area.length >= 3) swimArea = area;
}

// Sutherland-Hodgman: the part of convex polygon `subject` inside convex
// polygon `clip` (both as [{x, y}], either winding).
function clipPolygon(subject, clip) {
  const winding = Math.sign(signedArea(clip));
  let output = subject;
  for (let i = 0; i < clip.length && output.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p) => winding * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= 0;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      if (inside(p)) output.push(p);
      if (inside(p) !== inside(q)) {
        // Intersection of segment pq with the clip edge line ab
        const d1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        const d2 = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
        const t = d1 / (d1 - d2);
        output.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  return output;
}

function signedArea(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
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

// Each whale has its own color, used when it sings
const whaleColors = [
  '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c',
  '#38d9a9', '#4dabf7', '#9775fa', '#f783ac',
].map((c) => new THREE.Color(c));


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

// Species assigned per whale index (0-based). classic.glb is the app's
// original whale.obj rigged by tools/blender/run_classic.py.
const whaleModelUrls = {
  humpback: 'assets/humpback.glb',
  classic: 'assets/classic.glb',
  blue: 'assets/blue.glb',
  sperm: 'assets/sperm.glb',
};
const whaleSpeciesByIndex = [
  'humpback', // 1
  'blue',     // 2
  'humpback', // 3
  'classic',  // 4
  'humpback', // 5
  'classic',  // 6
  'classic',  // 7
  'sperm',    // 8
];
// The Blender pipeline normalises every whale to a body length of 1 unit
// (see normalise() in whale_pipeline.py); the whale slots here are only
// ~0.36-0.5 units apart, and the original static whale.obj placement (same
// layout) had a body length around 0.38, so that's the scale to match.
const BASE_WHALE_SCALE = 0.24;
// Extra uniform scale per species (blue whale is bigger, see plan step 4)
const whaleScaleBySpecies = { humpback: 1, classic: 1, blue: 1.2, sperm: 1 };

const gltfLoader = new THREE.GLTFLoader();

function loadGltf(url) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, resolve, undefined, reject);
  });
}

// Loaded skinned template per species, keyed by whaleModelUrls key.
// Falls back to humpback if a species fails to load (classic.glb missing).
async function loadWhaleTemplates() {
  const templates = {};
  const uniqueSpecies = [...new Set(whaleSpeciesByIndex)];
  await Promise.all(uniqueSpecies.map(async (species) => {
    try {
      const gltf = await loadGltf(whaleModelUrls[species]);
      // The Blender pipeline exports standard glTF: back = +Y, head = -Z,
      // tail = +Z (checked on the skeleton). This scene is Z-up, so +90 deg
      // about X puts the back on +Z and the head on +Y (-90 deg flipped the
      // whale onto its back with the head on -Y).
      gltf.scene.rotateX(Math.PI / 2);
      gltf.scene.updateMatrixWorld(true);
      // Clone the whole scene (not just the SkinnedMesh) so the bone/armature
      // hierarchy, wherever it sits relative to the mesh, comes along.
      templates[species] = { scene: gltf.scene, animations: gltf.animations };
    } catch (error) {
      console.warn(`Baleines: ${species} model unavailable, falling back to humpback`, error);
      templates[species] = null;
    }
  }));
  return templates;
}

const whales = [];       // top-level object per whale (position/orientation)
const whaleMeshes = [];  // its SkinnedMesh descendant (material assignment)
const whaleMixers = [];  // AnimationMixer playing the 'idle' swim clip
const whaleStates = [];  // WhaleState per whale (free swim / jump)
const whaleFins = [];    // { L, R } pectoral fin bones, steered on top of the clip
// Steepest nose-up angle of each whale's jump; also scales its height.
const whaleMaxPitchDeg = new Array(whalesCount).fill(55);
// Playback speed of the authored swim clip.
const SWIM_STROKE = 1.8;
// How far the pectoral fins angle to steer into a turn (radians).
const FIN_STEER_AMPLITUDE = THREE.MathUtils.degToRad(18);

const whalesLoaded = loadWhaleTemplates().then(async (templates) => {
  // Make sure we always have at least the humpback template to fall back on.
  if (!templates.humpback) {
    const gltf = await loadGltf(whaleModelUrls.humpback);
    gltf.scene.rotateX(Math.PI / 2);
    gltf.scene.updateMatrixWorld(true);
    templates.humpback = { scene: gltf.scene, animations: gltf.animations };
  }

  for (let i = 0; i < whalesCount; i++) {
    const species = whaleSpeciesByIndex[i];
    const template = templates[species] || templates.humpback;
    const effectiveSpecies = templates[species] ? species : 'humpback';

    // The loaded model (with its one-time up-axis fix baked into its own
    // rotation) is a static child; only the mount below is animated each
    // frame, so the axis fix never gets clobbered by the swim pose.
    const whaleModel = THREE.SkeletonUtils.clone(template.scene);
    const scale = BASE_WHALE_SCALE * whaleScaleBySpecies[effectiveSpecies];
    whaleModel.scale.setScalar(scale);

    const mount = new THREE.Object3D();
    mount.add(whaleModel);

    // Start from the original arc, then swim freely.
    const { posX, posY } = whaleTranslateFromIndex(i);
    mount.position.set(posX, posY, 0);
    mount.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(whaleModel);
    whales.push(mount);
    whaleMeshes.push(whaleModel.getObjectByProperty('type', 'SkinnedMesh'));
    whaleFins.push({
      L: whaleModel.getObjectByName('fin.L'),
      R: whaleModel.getObjectByName('fin.R'),
    });

    const mixer = new THREE.AnimationMixer(whaleModel);
    const idleClip = (template.animations || []).find((clip) => clip.name === 'idle');
    if (idleClip) mixer.clipAction(idleClip).play();
    // The authored clip's fluke/fin sway is subtle (a few degrees) and easy
    // to miss at this scale; play it faster so the swim stroke actually
    // reads as propulsion instead of a static pose.
    mixer.timeScale = SWIM_STROKE;
    whaleMixers.push(mixer);

    // Blue whale: it rarely breaches; a low, flat lunge that barely clears
    // the water. Lowered rest centre too.
    const isBlue = effectiveSpecies === 'blue';
    if (isBlue) whaleMaxPitchDeg[i] = 32;

    const size = box.getSize(new THREE.Vector3());
    whaleStates.push(WhaleState.createState(i, { x: posX, y: posY }, isBlue ? -0.01 : 0, {
      bodyLength: Math.max(size.x, size.y),
      // Varied start headings and cruising speeds so the pod doesn't move in step.
      heading: i * 2.4,
      speed: 0.06 + 0.01 * (i % 4),
    }));
  }
  progress.whale = 1;
  updateProgress();
});

// Sea floor
// Large enough to reach the (fogged) horizon of the low-camera looks.
const floorGeometry = new THREE.PlaneBufferGeometry(waterScale * 8, waterScale * 8);
floorGeometry.translate(0, 0, floorDepth);

// Sky used for the water reflections: a simple vertical gradient cube map
function createSkyTexture([top, bottom]) {
  const size = 64;
  const faces = [];
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, size);
    gradient.addColorStop(0, top);
    gradient.addColorStop(1, bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    faces.push(c);
  }
  const texture = new THREE.CubeTexture(faces);
  texture.needsUpdate = true;
  return texture;
}
const skyTexture = createSkyTexture(look.sky);

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
            deepWater: { value: look.deepWater },
            refractionFactor: { value: look.refraction },
            dispersion: { value: look.dispersion },
            reflectionMax: { value: look.reflectionMax },
            waterTint: { value: look.waterTint },
            fogColor: { value: look.fogColor },
            fogNear: { value: look.fog[0] },
            fogFar: { value: look.fog[1] },
            holeHalfSize: { value: 0 },
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

        // The rest of the sea, out to the horizon: flat and coarse, with a
        // hole where the detailed simulated surface above sits.
        this.outerMaterial = this.material.clone();
        this.outerMaterial.extensions = this.material.extensions;
        // clone() copies textures and colours: share them instead
        for (const name of ['skybox', 'deepWater', 'waterTint', 'fogColor']) {
          this.outerMaterial.uniforms[name].value = this.material.uniforms[name].value;
        }
        this.outerMaterial.uniforms['holeHalfSize'].value = waterScale / 2 - 0.001;
        const outerGeometry = new THREE.PlaneBufferGeometry(waterScale * 8, waterScale * 8, 128, 128);
        const outer = new THREE.Mesh(outerGeometry, this.outerMaterial);
        outer.frustumCulled = false;
        this.mesh.add(outer);
      });
  }

  setHeightTexture(waterTexture) {
    this.material.uniforms['water'].value = waterTexture;
    this.outerMaterial.uniforms['water'].value = waterTexture;
  }

  // 0 keeps the surface flat (when the simulation cannot be read)
  setWaterStrength(strength) {
    this.material.uniforms['waterStrength'].value = strength;
    this.outerMaterial.uniforms['waterStrength'].value = strength;
  }

  setEnvMapTexture(envMap) {
    this.material.uniforms['envMap'].value = envMap;
    this.outerMaterial.uniforms['envMap'].value = envMap;
  }

}


// Objects under the water (whales + sea floor).
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
          baseColor: { value: new THREE.Color() },
          glow: { value: 0.0 },
          glowColor: { value: new THREE.Color() },
          ambient: { value: look.ambient },
          diffuse: { value: look.diffuse },
          rimColor: { value: look.rimColor },
          rimStrength: { value: 0 },
          deepColor: { value: look.deepColor },
          depthTint: { value: look.depthTint },
          floorNoise: { value: 0 },
          fogColor: { value: look.fogColor },
          fogNear: { value: look.fog[0] },
          fogFar: { value: look.fog[1] },
          underwaterOnly: { value: 0 },
        },
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
      });
    });
  }

  // While rendering what the water surface refracts, leave out whatever is
  // above the surface (a whale in mid-jump).
  setUnderwaterOnly(enabled) {
    for (const material of this.whaleMaterials) {
      material.uniforms['underwaterOnly'].value = enabled ? 1 : 0;
    }
  }

  _createMaterial(baseColor, isWhale) {
    const material = this._baseMaterial.clone();
    // clone() copies the colours: share the look's instead
    for (const name of ['rimColor', 'deepColor', 'fogColor']) {
      material.uniforms[name].value = this._baseMaterial.uniforms[name].value;
    }
    material.uniforms['baseColor'].value = baseColor;
    material.uniforms['rimStrength'].value = isWhale ? look.rim : 0;
    material.uniforms['floorNoise'].value = isWhale ? 0 : look.floorNoise;
    // Whales: skinned, in the species colours painted by the rigging pipeline
    material.skinning = isWhale;
    material.vertexColors = isWhale;
    return material;
  }

  // whaleMeshes: SkinnedMesh instances already positioned/added to the scene
  // by the caller; floor: static PlaneBufferGeometry, not skinned.
  setGeometries(whaleMeshes, floor) {
    this._meshes = [];
    this.whaleMaterials = [];

    whaleMeshes.forEach((mesh, i) => {
      const material = this._createMaterial(look.whaleColor, true);
      material.uniforms['glowColor'].value = whaleColors[i];
      this.whaleMaterials.push(material);
      mesh.material = material;
      this._meshes.push(mesh);
    });

    const floorMaterial = this._createMaterial(look.floorColor, false);
    const floorMesh = new THREE.Mesh(floor, floorMaterial);
    floorMesh.frustumCulled = false;
    this._meshes.push(floorMesh);
  }

  setGlow(index, value) {
    this.whaleMaterials[index].uniforms['glow'].value = value;
  }

  // roots: top-level whale objects carrying position/scale (the SkinnedMesh
  // itself is a descendant and must not be reparented directly, or it loses
  // that placement); the floor mesh is added as-is.
  addTo(scene, roots) {
    for (let root of roots) {
      scene.add(root);
    }
    scene.add(this._meshes[this._meshes.length - 1]);
  }

}

// Marine snow: specks drifting and slowly sinking between the floor and the
// surface (under the water, so they are refracted with the rest).
class MarineSnow {

  constructor(count) {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * 1.7;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius;
      positions[i * 3 + 2] = Math.random();
      seeds[i] = Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        opacity: { value: look.snowOpacity },
        pixelRatio: { value: renderer.getPixelRatio() },
        floorZ: { value: floorDepth },
        surfaceZ: { value: waterHeight - 0.01 },
      },
      vertexShader: `
        uniform float time;
        uniform float pixelRatio;
        uniform float floorZ;
        uniform float surfaceZ;
        attribute float seed;
        varying float alpha;
        void main() {
          // position.z is a 0..1 phase: sink slowly, wrapping from floor to surface
          float h = fract(position.z - time * (0.004 + 0.006 * seed));
          vec3 p = vec3(position.xy, mix(floorZ, surfaceZ, h));
          p.x += 0.03 * sin(time * 0.3 + seed * 40.);
          p.y += 0.03 * cos(time * 0.23 + seed * 25.);
          vec4 mv = modelViewMatrix * vec4(p, 1.);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (1. + 1.6 * seed) * pixelRatio * 2. / -mv.z;
          // fade in/out at the top and bottom of the loop, and far away
          alpha = smoothstep(0., 0.1, h) * smoothstep(1., 0.9, h) * (1. - smoothstep(1.3, 1.7, length(p.xy)));
        }`,
      fragmentShader: `
        uniform float opacity;
        varying float alpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(0.85, 0.93, 1.), (1. - smoothstep(0.2, 0.5, d)) * alpha * opacity);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  update(time) {
    this.material.uniforms['time'].value = time;
  }

}

const waterSimulation = new WaterSimulation();
const marineSnow = new MarineSnow(isCoarsePointer ? 500 : 900);
const water = new Water();
const environment = new Environment();

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
  const nowSeconds = performance.now() / 1000;
  glowStart[index] = nowSeconds;
  pulseLabel(index);

  // C2/C4: starts an autonomous jump if the whale was idle; a whale already
  // jumping keeps its trajectory, this call only re-triggers wave/sound/glow.
  const state = whaleStates[index];
  if (state) WhaleState.startJump(state, nowSeconds);

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
    const state = whaleStates[index];
    const pan = state ? THREE.MathUtils.clamp(state.x, -1, 1) * 0.7 : 0;
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
// Whale number pads, grouped at the bottom of the screen (laid out in CSS)
// ---------------------------------------------------------------------------

const labelsContainer = document.getElementById('labels');
const labels = [];

// One pictogram per sound (24x24 line icons, drawn in the pad's text colour).
// 1, 7 and 8 are the percussive sounds: grouped as the "drum kit".
const padSounds = [
  { name: 'Stomp', drum: true, icon: '<ellipse cx="12" cy="10" rx="7" ry="2.5"/><path d="M5 10v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6M8 3.5l3 5M16 3.5l-3 5"/>' },
  { name: 'Deep bass', icon: '<path d="M2 13c3-6 6-6 9 0s6 6 9 0M4 20h16"/>' },
  { name: 'Trumpet', icon: '<path d="M3 10v4h4l9 5V5l-9 5H3zM19.5 8.5a5 5 0 0 1 0 7"/>' },
  { name: 'Ambience', icon: '<path d="M3 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>' },
  // Grunt: a short, rough burst in an otherwise flat line.
  { name: 'Grunt', icon: '<path d="M2 12h4l1.3-4.5 1.7 9 1.6-7 1.6 5.5 1.5-4 1.3 2.5.9-1.5H22"/>' },
  { name: 'Deep phrase', icon: '<path d="M4 5h16v10H9l-5 4zM8 10c1.3-2 2.7-2 4 0s2.7 2 4 0"/>' },
  // Cymbal: one tilted disc with its bell, on a tripod stand.
  { name: 'Cymbal', drum: true, icon: '<path d="M3.5 9.5L20.5 5.5M4 9.6c3 1.2 11 -.7 16.2 -4M11 7.3c.2-1 1-1.6 2-1.6M12.5 8v12.5M9 21l3.5-3 3.5 3"/>' },
  // Hi-hat: two stacked discs on a straight stand.
  { name: 'Hi-hat', drum: true, icon: '<ellipse cx="12" cy="6.5" rx="8" ry="1.6"/><ellipse cx="12" cy="10" rx="8" ry="1.6"/><path d="M12 11.6V21M8.5 21h7"/>' },
];

function createLabels() {
  const groups = {
    drums: labelsContainer.querySelector('.pads-drums'),
    voices: labelsContainer.querySelector('.pads-voices'),
  };
  for (let i = 0; i < whalesCount; i++) {
    const sound = padSounds[i];
    const label = document.createElement('button');
    label.className = 'whale-label';
    label.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${sound.icon}</svg>`;
    label.style.setProperty('--whale-color', `#${whaleColors[i].getHexString()}`);
    label.setAttribute('aria-label', `${sound.name} (whale ${i + 1})`);
    label.title = `${sound.name} · ${i + 1}`;
    label.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      singWhale(i);
    });
    (sound.drum ? groups.drums : groups.voices).appendChild(label);
    labels.push(label);
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
  for (let i = 0; i < whaleStates.length; i++) {
    const dx = whaleStates[i].x - point.x;
    const dy = whaleStates[i].y - point.y;
    const dist = dx * dx + dy * dy;
    if (dist < min) {
      min = dist;
      closest = i;
    }
  }
  return closest;
}

// Pad (or its keyboard key): the ripple rises from the water under the pad,
// the whale itself sings, glows and jumps wherever it is.
function singWhale(index) {
  if (!ready) return;
  const label = labels[index];
  if (label) {
    const rect = canvas.getBoundingClientRect();
    const pad = label.getBoundingClientRect();
    pointer.x = (pad.left + pad.width / 2 - rect.left) / rect.width * 2 - 1;
    pointer.y = -(pad.top + pad.height / 2 - rect.top) / rect.height * 2 + 1;
    const point = waterPointUnderPointer();
    if (point) waterSimulation.addDrop(renderer, point.x, point.y, 0.03, 0.02);
  }
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
  water.setWaterStrength(0);
  diagnostics.simulation = 'none';
  diagnostics.water = 'flat';
}

function showDiagnostics() {
  const text = [diagnostics.build, diagnostics.gpu, `water ${diagnostics.simulation}`,
    diagnostics.water].join(' \u00b7 ');
  console.info('Baleines:', text);
  const element = document.getElementById('diag');
  if (element) element.textContent = text;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastAnimateTime = performance.now() / 1000;

function animate() {
  // Fade the whales glow
  const now = performance.now() / 1000;
  // Capped so a backgrounded tab doesn't teleport the whales on return.
  const delta = Math.min(0.1, Math.max(0, now - lastAnimateTime));
  lastAnimateTime = now;

  for (let i = 0; i < whalesCount; i++) {
    const level = Math.max(0, 1 - (now - glowStart[i]) / glowDuration);
    glowLevels[i] = level;
    environment.setGlow(i, level * level * (3 - 2 * level));
  }

  // Free swimming (avoiding each other and the screen edges), jumps, swim clip.
  WhaleState.step(whaleStates, now, delta, swimArea);
  for (let i = 0; i < whales.length; i++) {
    const state = whaleStates[i];
    const splash = WhaleState.checkSplash(state);
    if (splash) waterSimulation.addDrop(renderer, splash.x, splash.y, splash.radius, splash.strength);

    const pose = WhaleState.updatePose(state, now, whaleMaxPitchDeg[i]);
    const whale = whales[i];
    whale.position.set(pose.x, pose.y, pose.z || 0);
    // The model's head points along +Y, while `heading` is the direction of
    // travel measured from +X, hence the -PI/2 (otherwise it swims sideways).
    // 'ZXY': yaw about world Z first, then pitch about the whale's own
    // lateral axis, then roll about its own head-tail axis. With the default
    // 'XYZ' the bank became a nose dive depending on the heading.
    whale.rotation.set(pose.pitch || 0, pose.roll || pose.tilt || 0, (pose.heading || 0) - Math.PI / 2, 'ZXY');

    // Fluke beat: faster while gathering speed for a jump, resting in the air
    whaleMixers[i].timeScale = SWIM_STROKE * (pose.stroke || 1);
    whaleMixers[i].update(delta);

    // Steering reads through the pectoral fins (angled into the turn), on
    // top of the clip's own caudal-fin swim stroke — not from an abstract
    // yaw of the whole body.
    const fins = whaleFins[i];
    const steer = pose.steer || 0;
    if (fins && fins.L) fins.L.rotateX(-steer * FIN_STEER_AMPLITUDE);
    if (fins && fins.R) fins.R.rotateX(steer * FIN_STEER_AMPLITUDE);
  }

  // Update the water (~30 simulation steps per second)
  if (clock.getElapsedTime() > 0.032) {
    if (waterEnabled) {
      waterSimulation.stepSimulation(renderer);
    }

    const waterTexture = waterSimulation.target.texture;

    water.setHeightTexture(waterTexture);

    clock.start();
  }

  marineSnow.update(now);

  // Render everything but the refractive water
  renderer.setRenderTarget(temporaryRenderTarget);
  renderer.setClearColor(look.fogColor, 1);
  renderer.clear();

  water.mesh.visible = false;
  environment.setUnderwaterOnly(true);
  renderer.render(scene, camera);
  environment.setUnderwaterOnly(false);

  water.setEnvMapTexture(temporaryRenderTarget.texture);

  // Then render the final scene with the refractive water
  renderer.setRenderTarget(null);
  renderer.setClearColor(look.fogColor, 1);
  renderer.clear();

  water.mesh.visible = true;
  renderer.render(scene, camera);
  if (captureMode) window.__frames = (window.__frames || 0) + 1;

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

// C7: exposed for tests / accessibility toggles.
window.setReducedMotion = WhaleState.setReducedMotion;

const loaded = [
  waterSimulation.loaded,
  water.loaded,
  environment.loaded,
  whalesLoaded,
];

Promise.all(loaded).then(() => {
  environment.setGeometries(whaleMeshes, floorGeometry);

  environment.addTo(scene, whales);

  scene.add(water.mesh);
  scene.add(marineSnow.points);

  createLabels();
  resize();

  checkWater();
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
