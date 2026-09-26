// Per-whale idle/jump state machine (plan rules C1-C7).
// Loaded as a plain global script, before index.js.

'use strict';

const WhaleState = (() => {
  const JUMP_DURATION = 1.4; // seconds
  const IDLE_RADIUS = 0.04;
  // Any path traversed at constant ANGULAR rate (a circle, an ellipse...)
  // has near-zero linear speed somewhere while still needing the heading to
  // sweep through a wide angle there — that reads as pivoting in place, not
  // swimming. A "stadium" track (two straight lanes joined by two constant-
  // radius half-circle turns), traversed at constant LINEAR speed, never
  // does that: it glides in a straight line, then banks through a real arc
  // at steady speed, like an actual whale doing a U-turn.
  const STRAIGHT_RATIO = 0.6; // half-length of each straight, as a fraction of `radius`
  const TURN_RATIO = 0.4;     // turn radius, as a fraction of `radius` (straight+turn = radius)
  const SPLASH_TIMES = [0.30, 0.85]; // seconds into the jump

  let reducedMotion = false;

  function setReducedMotion(value) {
    reducedMotion = !!value;
  }

  // origin: {x, y} center of the whale's rest position (fixed, from
  // whaleTranslateFromIndex). index used to derive rotation sign/speed/phase
  // offset deterministically (not random).
  function createState(index, origin, baseZ, radius) {
    const sign = index % 2 === 0 ? 1 : -1;
    const speed = (2 * Math.PI) / (9 + index * 0.4); // ~10s period, alternated
    return {
      index,
      origin,
      baseZ: baseZ || 0,
      // Sized from the whale's own body length by the caller so the circle
      // reads as swimming in a loop, not spinning in place (radius << body
      // length looks like a pinwheel).
      radius: radius || IDLE_RADIUS,
      sign,
      speed,
      // current idle phase = phaseOffset + sign * speed * t
      phaseOffset: (index / 8) * Math.PI * 2, // stagger whales around the circle
      jumping: false,
      jumpStart: 0,
      suspendedPhase: 0,
      // captured at jump start: position/heading to jump from, held fixed
      jumpOrigin: { x: origin.x, y: origin.y },
      jumpHeading: 0,
      lastSplashIndex: -1,
    };
  }

  // Position/heading/tilt for a point at normalized arc-length u in [0, 1)
  // around a stadium track: straight (+X) / half-circle turn / straight
  // (-X) / half-circle turn, centered on the origin.
  function stadiumPose(u, L, R) {
    const perimeter = 4 * L + 2 * Math.PI * R;
    let s = u * perimeter;

    if (s < 2 * L) {
      // Bottom straight, moving +X.
      return { x: -L + s, y: -R, heading: 0, curvature: 0 };
    }
    s -= 2 * L;

    const halfTurn = Math.PI * R;
    if (s < halfTurn) {
      // Right-hand turn, center (L, 0): sweeps heading 0 -> PI.
      const theta = -Math.PI / 2 + s / R;
      return {
        x: L + R * Math.cos(theta),
        y: R * Math.sin(theta),
        heading: theta + Math.PI / 2,
        curvature: 1, // turning to port (left), banking/steering sign
      };
    }
    s -= halfTurn;

    if (s < 2 * L) {
      // Top straight, moving -X.
      return { x: L - s, y: R, heading: Math.PI, curvature: 0 };
    }
    s -= 2 * L;

    // Left-hand turn, center (-L, 0): sweeps heading PI -> 2*PI.
    const theta = Math.PI / 2 + s / R;
    return {
      x: -L + R * Math.cos(theta),
      y: R * Math.sin(theta),
      heading: theta + Math.PI / 2,
      curvature: -1, // turning to starboard (right): opposite bank/steer sign
    };
  }

  // C1: idle motion around origin, patrolling a stadium-shaped track at
  // constant linear speed (see stadiumPose above).
  function idlePose(state, t) {
    const phase = state.phaseOffset + state.sign * state.speed * t;
    const L = state.radius * STRAIGHT_RATIO;
    const R = state.radius * TURN_RATIO;
    // phase already decreases over time when state.sign < 0 (see its
    // definition above), so u naturally runs backwards along the same
    // track without needing to mirror it into a different path.
    let u = (phase / (2 * Math.PI)) % 1;
    if (u < 0) u += 1;

    const local = stadiumPose(u, L, R);
    const heading = state.sign < 0 ? local.heading + Math.PI : local.heading;
    // Reversing travel direction also flips which way "left/right" reads
    // from the whale's own point of view.
    const steer = local.curvature * state.sign;
    // Positive roll drops the right side, so a left turn (steer > 0) banks negative.
    const tilt = -steer * THREE.MathUtils.degToRad(15);
    return {
      x: state.origin.x + local.x,
      y: state.origin.y + local.y,
      z: state.baseZ,
      heading,
      tilt,
      // -1..1: 0 swimming straight, sign/magnitude is how hard it's turning
      // — the caller uses this to angle the pectoral fins for steering.
      steer,
    };
  }

  // C2/C3: called on every click; starts a jump only if the whale is idle.
  function startJump(state, t) {
    if (state.jumping) return;
    const pose = idlePose(state, t);
    state.jumping = true;
    state.jumpStart = t;
    state.suspendedPhase = state.phaseOffset + state.sign * state.speed * t;
    state.jumpOrigin.x = pose.x;
    state.jumpOrigin.y = pose.y;
    state.jumpHeading = pose.heading;
    state.lastSplashIndex = -1;
  }

  // C4: jump trajectory, pure function of elapsed time since jumpStart, in
  // the (position, heading) frame captured at jumpStart. No horizontal
  // travel, only height/pitch/roll.
  function jumpPose(state, t, maxPitchDeg) {
    const elapsed = t - state.jumpStart;
    const u = THREE.MathUtils.clamp(elapsed / JUMP_DURATION, 0, 1);
    // Smooth up-and-back-down arc, peak around mid-jump.
    const arc = Math.sin(u * Math.PI);
    const height = state.baseZ + arc * 0.12;
    const pitchDeg = (maxPitchDeg == null ? 46 : maxPitchDeg);
    const pitch = arc * THREE.MathUtils.degToRad(pitchDeg);
    const roll = Math.sin(u * Math.PI * 2) * THREE.MathUtils.degToRad(8);

    return {
      x: state.jumpOrigin.x,
      y: state.jumpOrigin.y,
      z: height,
      heading: state.jumpHeading,
      pitch,
      roll,
      done: elapsed >= JUMP_DURATION,
    };
  }

  // C6: splash callback fired at fixed instants during the jump (water
  // exit/entry), independent of clicks. Call once per frame; returns the
  // splash position if one should fire this frame, else null.
  function checkSplash(state, t) {
    if (!state.jumping) return null;
    const elapsed = t - state.jumpStart;
    for (let i = 0; i < SPLASH_TIMES.length; i++) {
      if (i <= state.lastSplashIndex) continue;
      if (elapsed >= SPLASH_TIMES[i]) {
        state.lastSplashIndex = i;
        return { x: state.jumpOrigin.x, y: state.jumpOrigin.y };
      }
    }
    return null;
  }

  // C5: advances the whale for one frame, handling the idle/jump/reduced
  // motion transitions. Returns the pose to apply to the SkinnedMesh.
  function updatePose(state, t, maxPitchDeg) {
    if (reducedMotion) {
      // C7: frozen position/heading, no circle, no jump — just surface roll.
      const roll = state.jumping
        ? Math.sin((t - state.jumpStart) * Math.PI * 2) * THREE.MathUtils.degToRad(6)
        : 0;
      if (state.jumping && (t - state.jumpStart) >= JUMP_DURATION) {
        state.jumping = false;
      }
      return { x: state.origin.x, y: state.origin.y, z: state.baseZ, heading: 0, pitch: 0, roll, tilt: 0 };
    }

    if (state.jumping) {
      const pose = jumpPose(state, t, maxPitchDeg);
      if (pose.done) {
        state.jumping = false;
        // Rebase phaseOffset so idlePose(t) picks up exactly at
        // suspendedPhase and grows from here on, with no pose jump.
        state.phaseOffset = state.suspendedPhase - state.sign * state.speed * t;
      } else {
        return pose;
      }
    }

    return idlePose(state, t);
  }

  return {
    createState,
    idlePose,
    startJump,
    jumpPose,
    checkSplash,
    updatePose,
    setReducedMotion,
    JUMP_DURATION,
  };
})();

if (typeof window !== 'undefined') window.WhaleState = WhaleState;
