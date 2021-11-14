// show stats for quick debug
// const stats = new Stats();
// stats.showPanel(0);
// document.body.appendChild(stats.domElement);

// show spector
// var spector = new SPECTOR.Spector();
// spector.displayUI();

// TODO split this file

const canvas = document.getElementById('canvas');
let width = canvas.width;
let offsetWidth = 0;
let height = canvas.height;
let offsetHeight = 0;

if (window.innerHeight > window.innerWidth) {
  offsetHeight = canvas.height - canvas.width * 2 / 3;
  canvas.height = canvas.width * 2 / 3;
  width = canvas.width;
  height = canvas.height;
} else {
  offsetWidth = canvas.width - canvas.height * 3 / 2;
  canvas.width = canvas.height * 3 / 2;
  width = canvas.width;
  height = canvas.height;
}



let fullScreen = false
function openFullscreen() {
  if (canvas.requestFullscreen) {
    canvas.requestFullscreen();
  } else if (canvas.webkitRequestFullscreen) { /* Safari */
    canvas.webkitRequestFullscreen();
  } else if (canvas.msRequestFullscreen) { /* IE11 */
    canvas.msRequestFullscreen();
  }
  fullScreen = true;
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
const waterHeight = 0.1;
const waterPosition = new THREE.Vector3(0, 0, waterHeight);
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

controls.target = new THREE.Vector3(0, 0, waterHeight);

controls.minPolarAngle = Math.PI / 6;
controls.maxPolarAngle = Math.PI / 6;
controls.enableRotate = false;
controls.minDistance = 2.7;
controls.maxDistance = 2.7;

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

// whale plane
const whalePlaneGeometry = new THREE.PlaneGeometry(waterScale, waterScale);
const whalePlaneMesh = new THREE.Mesh(targetgeometry);

// Geometries
const waterGeometry = new THREE.PlaneBufferGeometry(waterScale, waterScale, waterDepth, waterDepth);

// place whales triangle form
const initialPosX = 0.1;
const initialPosY = .5;
const posRangeX = 1.8;
const posRangeY = 3.0;

let whales = [];
let whalesCount = 8;
let whalesPosition = [];

function whaleTranslateFromIndex(i) {
  // convert from [0,whalesCount[ to [-1,1]
  let posX = initialPosX + posRangeX / (whalesCount - 1) * i - 1;
  let posY = initialPosY + posRangeY / (whalesCount - 1) * i - 1;

  if (i == whalesCount / 2 - 1) {
    posX -= .05
  } else if (i == whalesCount / 2) {
    posX += .05
  }

  if (i >= whalesCount / 2) {
    posY = initialPosY + posRangeY / (whalesCount - 1) * ((whalesCount - 1) - i) - 1;
  }

  return { posX, posY };
}

const objLoader = new THREE.OBJLoader();
const whalesLoaded = new Promise((resolve) => {
  objLoader.load('assets/whale.obj', (whaleGeometry) => {
    whaleGeometry = whaleGeometry.children[0].geometry;
    whaleGeometry.computeVertexNormals();
    const size = 0.0005;

    whaleGeometry.rotateZ(Math.PI / 2.);
    whaleGeometry.scale(size, size, size);

    for (var i = 0; i < whalesCount; i++) {
      let whale = whaleGeometry.clone();
      let { posX, posY } = whaleTranslateFromIndex(i);
      whale.translate(posX, posY, 0);
      whale.computeBoundingSphere();
      let { x, y, z } = whale.boundingSphere.center;
      whalesPosition.push({ x, y, z });
      //console.log("whale i:", i, "x y z", x, y, z);
      whales.push(whale)
    }
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
    this.lastpos = null;

    this.loaded = Promise.all(shadersPromises).then(([vertexShader, fragmentShader]) => {
      this._material = new THREE.ShaderMaterial({
        uniforms: {
          light: { value: light },
          caustics: { value: null },
          lightProjectionMatrix: { value: camera.projectionMatrix },
          lightViewMatrix: { value: camera.matrixWorldInverse },
          playingWhalePos: { type: 'vec3', value: [0, 0, 0] },
          rand: { type: 'float', value: 1.0 }
        },
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
      });

    });
  }


  setNoteColor() {
    //console.log(currentWhalePos);
    if (this.lastpos != currentWhalePos) {
      this._material.uniforms['playingWhalePos'].value = currentWhalePos;
      this._material.uniforms['rand'].value = Math.random();
      this.lastpos = currentWhalePos;
    }
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
  //debug stats
  //stats.begin();

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

  //debug stats
  //stats.end();

  window.requestAnimationFrame(animate);
}

function mouseFromEvent(event) {
  if (fullScreen) {
    //console.log("event:", event.clientX, event.clientY, "rect:", window.innerWidth, window.innerHeight);
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = - (event.clientY / window.innerHeight) * 2 + 1;
  } else {
    const rect = canvas.getBoundingClientRect();
    //console.log("event:", event.clientX, event.clientY, "rect:", rect.left, rect.top, "width", width, "height", height);
    mouse.x = (event.clientX - rect.left) * 2 / width - 1;
    mouse.y = - (event.clientY - rect.top) * 2 / height + 1;
  }
}

function onMouseMove(event) {
  mouseFromEvent(event);
  raycaster.setFromCamera(mouse, camera);

  const intersects = raycaster.intersectObject(targetmesh);

  for (let intersect of intersects) {
    waterSimulation.addDrop(renderer, intersect.point.x, intersect.point.y, 0.03, 0.01);
  }
}

let currentWhalePos = [0, 0, 0];
function whalePosFromNote(note) {
  let idx = notes.indexOf(note);
  let { x, y, z } = whalesPosition[idx];
  //[-1,1]->[0,1]
  let matX = x / 2.0 + 0.5;
  let matY = y / 2.0 + 0.5;
  let matZ = z / 2.0 + 0.5;
  //console.log("whalePosFromNote", note, x, matX)
  return [matX, matY, matZ];
}


function playNote(note) {
  currentWhalePos = whalePosFromNote(note);
  const audio = document.querySelector(`audio[data-key="${note}"]`);
  audio.currentTime = 0;
  audio.play();
}

function removeTransition(e) {
  if (e.propertyName !== "transform") return;
  // the coordinate here are wrong in full screen mode
  //console.log("xoff", widthOffset, "yoff", heightOffset, "m", mouse.x, mouse.y, "e", event)
  this.classList.remove("playing");
}

// keep it to 8 notes
let notes = [
  "A0",
  "B0",
  "C0",
  "D0",
  "E0",
  "F0",
  "G0",
  "A1"];

let keys = [1, 2, 3, 4, 5, 6, 7, 8];

function digitFromPos(mouse) {

  raycaster.setFromCamera(mouse, camera);

  const intersects = raycaster.intersectObject(whalePlaneMesh);
  var projectedPos;
  for (let intersect of intersects) {
    projectedPos = new THREE.Vector3(intersect.point.x, intersect.point.y, intersect.point.z);
  }

  if (!projectedPos) {
    console.error("no intersect");
    return;
  }
  let digit = 0;
  let min = 100.0;
  let whaleX, whaleY, whaleZ;
  //console.log(whalesPosition);
  for (let i = 0; i < whalesCount; i++) {
    let { x, y, z } = whalesPosition[i];
    let whalePos = new THREE.Vector3(x, y, z);
    let dist = whalePos.distanceTo(projectedPos);
    if (dist < min) {
      min = dist;
      digit = i + 1;
      whaleX = x;
      whaleY = y;
      whaleZ = z;
    }
  }
  const material = new THREE.LineBasicMaterial({
    color: 0x00ff00
  });
  // const points = [];
  // points.push(projectedPos);
  // points.push(new THREE.Vector3(whaleX, whaleY, whaleZ));

  // const geometry = new THREE.BufferGeometry().setFromPoints(points);

  // const drawLine = new THREE.Line(geometry, material);
  // scene.add(drawLine);
  //console.log("posWhale", whaleX, whaleY, whaleZ, "posinter", targetX, targetY, targetZ, "dist", min);
  if (!keys.includes(digit)) {
    console.error("invalid digit computed", digit)
    return -1
  }
  return digit;
}

function onKeyPressed(event) {
  let digit = parseInt(event.key)
  //console.log(event, digit)
  if (keys.includes(digit)) {
    if (event.repeat) {
      return
    }

    let { x, y } = whalesPosition[digit - 1];
    //console.log("draw", x, y);
    waterSimulation.addDrop(renderer, x, y, 0.03, 0.02);
    playNote(notes[digit - 1]);
  }
}

function playNoteAndDropFromMouse(mouse) {

  raycaster.setFromCamera(mouse, camera);

  const intersects = raycaster.intersectObject(targetmesh);

  for (let intersect of intersects) {
    waterSimulation.addDrop(renderer, intersect.point.x, intersect.point.y, 0.03, 0.02);

    let digit = digitFromPos(mouse);
    if (digit > 0) {
      // console.log("computed digit", digit);
      playNote(notes[digit - 1]);
    }
    // stop at first intersect
    return;
  }
}

function onMouseDown(event) {
  mouseFromEvent(event)

  playNoteAndDropFromMouse(mouse);
}


function onTouch(event) {
  //console.log("touch", event);
  event.preventDefault();
  var touches = event.changedTouches;

  for (var i = 0; i < touches.length; i++) {
    //console.log("touches", i, touches[i],touches[i].clientX,touches[i].clientY);

    mouseFromEvent(touches[i]);
    playNoteAndDropFromMouse(mouse);
  }

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
  const envGeometries = whales;

  environmentMap.setGeometries(envGeometries);
  environment.setGeometries(envGeometries);

  environment.addTo(scene);

  scene.add(water.mesh);

  caustics.setDeltaEnvTexture(1. / environmentMap.size);

  canvas.addEventListener('mousemove', { handleEvent: onMouseMove });
  canvas.addEventListener('mousedown', { handleEvent: onMouseDown });
  canvas.addEventListener("touchstart", onTouch, false);
  canvas.addEventListener('keydown', { handleEvent: onKeyPressed });


  animate();
});
