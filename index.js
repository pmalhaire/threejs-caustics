// show stats for quick debug
const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.domElement);

const canvas = document.getElementById('canvas');
if (window.innerHeight > window.innerWidth) {
  canvas.width = window.innerWidth;
  canvas.height = window.innerWidth * 2 / 3;
} else {
  canvas.width = window.innerHeight * 3 / 2;
  canvas.height = window.innerHeight;
}

const width = canvas.width;
const height = canvas.height;


function openFullscreen() {
  if (canvas.requestFullscreen) {
    canvas.requestFullscreen();
  } else if (canvas.webkitRequestFullscreen) { /* Safari */
    canvas.webkitRequestFullscreen();
  } else if (canvas.msRequestFullscreen) { /* IE11 */
    canvas.msRequestFullscreen();
  }
}


// Colors
const black = new THREE.Color('black');
const white = new THREE.Color('white');

function loadFile(filename) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.FileLoader();

    loader.load(filename, (data) => {
      resolve(data);
    });
  });
}

// Constants
const waterPosition = new THREE.Vector3(0, 0, 0.8);
const waterSize = 1024;
// number of segment in water
const waterDepth = 1024;
const envSize = 1024;
const waterScale = 4;
// Create directional light
// TODO Replace this by a THREE.DirectionalLight and use the provided matrix (check that it's an Orthographic matrix as expected)
const light = [0., 0., -1.];

// Create Renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 100);
camera.up.set(0, 0, 1);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
renderer.setSize(width, height);
renderer.autoClear = false;

// Create mouse Controls
const controls = new THREE.OrbitControls(
  camera,
  canvas
);

controls.target = new THREE.Vector3(0, 0, .8);

controls.minPolarAngle = Math.PI / 6;
controls.maxPolarAngle = Math.PI / 6;
controls.enableRotate = false;
controls.minDistance = 2.1;
controls.maxDistance = 2.1;

// Target for computing the water refraction
const temporaryRenderTarget = new THREE.WebGLRenderTarget(width, height);

// Clock
const clock = new THREE.Clock();

// Ray caster
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const targetgeometry = new THREE.PlaneGeometry(waterScale, waterScale);
for (let vertex of targetgeometry.vertices) {
  vertex.z = waterPosition.z;
}
const targetmesh = new THREE.Mesh(targetgeometry);

// Geometries
const waterGeometry = new THREE.PlaneBufferGeometry(waterScale, waterScale, waterDepth, waterDepth);

const objLoader = new THREE.OBJLoader();
let whale;
const whaleLoaded = new Promise((resolve) => {
  objLoader.load('assets/whale.obj', (whaleGeometry) => {
    whaleGeometry = whaleGeometry.children[0].geometry;
    whaleGeometry.computeVertexNormals();
    const size = 0.001;
    whaleGeometry.rotateX(-Math.PI / 6.);
    whaleGeometry.scale(size, size, size);
    whaleGeometry.translate(-.6, 1, -1);

    whale = whaleGeometry;
    resolve();
  });
});


// Background box
const geometry = new THREE.BoxGeometry(waterScale, waterScale, waterScale);
const cube = new THREE.Mesh(geometry);
scene.background = cube;

class WaterSimulation {

  constructor() {
    this._camera = camera;

    this._geometry = new THREE.PlaneBufferGeometry(waterScale, waterScale);

    this._targetA = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
    this._targetB = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
    this.target = this._targetA;

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
            delta: { value: [1 / 216, 1 / 216] },  // TODO: Remove this useless uniform and hardcode it in shaders?
            texture: { value: null },
          },
          vertexShader: vertexShader,
          fragmentShader: updateFragmentShader,
        });

        this._dropMesh = new THREE.Mesh(this._geometry, dropMaterial);
        this._updateMesh = new THREE.Mesh(this._geometry, updateMaterial);
      });
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

    // render mesh for camera
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
            envMap: { value: null },
            skybox: { value: cube },
          },
          vertexShader: vertexShader,
          fragmentShader: fragmentShader,
        });
        this.material.extensions = {
          derivatives: true
        };

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.position.set(waterPosition.x, waterPosition.y, waterPosition.z);
      });
  }

  setHeightTexture(waterTexture) {
    this.material.uniforms['water'].value = waterTexture;
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
    this.target = new THREE.WebGLRenderTarget(this.size, this.size, { type: THREE.FloatType });

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
    this._meshes = [];

    for (let geometry of geometries) {
      this._meshes.push(new THREE.Mesh(geometry, this._material));
    }
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
    this.target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });

    this._waterGeometry = new THREE.PlaneBufferGeometry(waterScale, waterScale, waterSize, waterSize);

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
      });
  }

  setDeltaEnvTexture(deltaEnvTexture) {
    this._waterMaterial.uniforms['deltaEnvTexture'].value = deltaEnvTexture;
  }

  setTextures(waterTexture, envTexture) {
    this._waterMaterial.uniforms['env'].value = envTexture;
    this._waterMaterial.uniforms['water'].value = waterTexture;
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


class Environment {

  constructor() {
    const shadersPromises = [
      loadFile('shaders/environment/vertex.glsl'),
      loadFile('shaders/environment/fragment.glsl')
    ];

    this._meshes = [];

    this.loaded = Promise.all(shadersPromises).then(([vertexShader, fragmentShader]) => {
      this._material = new THREE.ShaderMaterial({
        uniforms: {
          light: { value: light },
          caustics: { value: null },
          lightProjectionMatrix: { value: camera.projectionMatrix },
          lightViewMatrix: { value: camera.matrixWorldInverse },
          note: { type: 'float', value: .4 },
        },
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
      });

    });
  }


  setNoteColor() {
    this._material.uniforms['note'].value = currentNote;
  }
  setGeometries(geometries) {
    this._meshes = [];

    for (let geometry of geometries) {
      this._meshes.push(new THREE.Mesh(geometry, this._material));
    }
  }

  updateCaustics(causticsTexture) {
    this._material.uniforms['caustics'].value = causticsTexture;
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

// Main rendering loop
function animate() {
  stats.begin();

  // Update the water
  if (clock.getElapsedTime() > 0.032) {
    waterSimulation.stepSimulation(renderer);

    const waterTexture = waterSimulation.target.texture;

    water.setHeightTexture(waterTexture);

    environmentMap.render(renderer);
    const environmentMapTexture = environmentMap.target.texture;

    caustics.setTextures(waterTexture, environmentMapTexture);
    caustics.render(renderer);
    const causticsTexture = caustics.target.texture;

    environment.updateCaustics(causticsTexture);
    environment.setNoteColor();

    clock.start();
  }

  // Render everything but the refractive water
  renderer.setRenderTarget(temporaryRenderTarget);
  renderer.setClearColor(white, 1);
  renderer.clear();

  water.mesh.visible = false;
  renderer.render(scene, camera);

  water.setEnvMapTexture(temporaryRenderTarget.texture);

  // Then render the final scene with the refractive water
  renderer.setRenderTarget(null);
  renderer.setClearColor(white, 1);
  renderer.clear();

  water.mesh.visible = true;
  renderer.render(scene, camera);

  controls.update();

  stats.end();

  window.requestAnimationFrame(animate);
}

function onMouseMove(event) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = (event.clientX - rect.left) * 2 / width - 1;
  mouse.y = - (event.clientY - rect.top) * 2 / height + 1;

  raycaster.setFromCamera(mouse, camera);

  const intersects = raycaster.intersectObject(targetmesh);

  for (let intersect of intersects) {
    waterSimulation.addDrop(renderer, intersect.point.x, intersect.point.y, 0.03, 0.02);
  }
}

let currentNote = 0;
function playNote(note) {
  currentNote = notes.indexOf(note) / 10.0;
  const audio = document.querySelector(`audio[data-key="${note}"]`);
  audio.currentTime = 0;
  audio.play();
}

function removeTransition(e) {
  if (e.propertyName !== "transform") return;
  this.classList.remove("playing");
}

let notes = [
  "A0",
  "B0",
  "C0",
  "D0",
  "E0",
  "F0",
  "G0",
  "A1",
  "B1"];

function onKeyPressed(event) {
  let keys = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  let digit = parseInt(event.key)
  //console.log(event, digit)
  if (keys.includes(digit)) {
    if (event.repeat) {
      return
    }
    let x = (digit - .1) / 4. - 1.1;
    let y = 0.;
    //console.log("draw", x, y);
    waterSimulation.addDrop(renderer, x, y, 0.03, 0.02);
    playNote(notes[digit - 1]);
  }

}

function onTouch(event) {
  //console.log("touch", event);
  event.preventDefault();
  var touches = event.changedTouches;

  for (var i = 0; i < touches.length; i++) {
    //console.log("touches", i, touches[i],touches[i].clientX,touches[i].clientY);
    const rect = canvas.getBoundingClientRect();

    mouse.x = (touches[i].clientX - rect.left) * 2 / width - 1;
    mouse.y = - (touches[i].clientY - rect.top) * 2 / height + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObject(targetmesh);

    for (let intersect of intersects) {
      if (event.repeat) {
        return
      }
      waterSimulation.addDrop(renderer, intersect.point.x, intersect.point.y, 0.03, 0.02);
      let digit = Math.floor((intersect.point.x + 1.1) * 4.0 + .1) + 1;
      // console.log("computed digit", digit);
      playNote(notes[digit - 1]);
    }
  }

}

const loaded = [
  waterSimulation.loaded,
  water.loaded,
  environmentMap.loaded,
  environment.loaded,
  caustics.loaded,
  whaleLoaded,
];

Promise.all(loaded).then(() => {
  const envGeometries = [whale];

  environmentMap.setGeometries(envGeometries);
  environment.setGeometries(envGeometries);

  environment.addTo(scene);
  scene.add(water.mesh);

  caustics.setDeltaEnvTexture(1. / environmentMap.size);

  canvas.addEventListener('mousemove', { handleEvent: onMouseMove });
  canvas.addEventListener("touchstart", onTouch, false);
  canvas.addEventListener('keydown', { handleEvent: onKeyPressed });


  animate();
});
