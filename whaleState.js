// Per-whale free swimming + jump state machine.
// Loaded as a plain global script, before index.js.
//
// Each whale swims forward at a steady speed and only changes direction by
// turning at a limited yaw rate (never on the spot): a gentle meander, plus
// steering away from the other whales and from the edges of the visible sea.
// The yaw rate drives the bank and the pectoral fins (`steer`), so turns read
// as steered by the fins while the fluke clip provides the thrust.

'use strict';

const WhaleState = (() => {
  const JUMP_DURATION = 2.4; // seconds, from the wind-up dip to swimming again
  // Height of the whale's centre through the jump (relative to its swimming
  // depth), as keys over the normalised jump time: dip to gain speed, burst
  // out, apex, fall back, dive under, level out. Interpolated as a smooth
  // (C1) curve with flat ends, so the jump starts and ends at rest vertically.
  const JUMP_KEYS = [[0, 0], [0.18, -0.045], [0.42, 0.10], [0.56, 0.24], [0.70, 0.10], [0.84, -0.06], [1, 0]];
  // Nose angle through the jump, as a fraction of the whale's steepest
  // pitch: slightly down in the dip, up on the way out, rolling over at the
  // apex, down on re-entry, level again. Its own curve rather than the
  // direction of travel: that one flips too fast at the apex, where the
  // whale barely moves forward.
  const PITCH_KEYS = [[0, 0], [0.13, -0.2], [0.32, 0.95], [0.47, 0.8], [0.60, 0], [0.74, -0.85], [0.88, -0.3], [1, 0]];
  const SURFACE = 0.07;      // centre height at which the body breaks the surface
  const MAX_TURN_RATE = 0.9; // rad/s: the tightest turn a whale will make
  const TURN_EASE = 2.5;     // 1/s: how fast the yaw rate follows the steering wish
  const BANK = THREE.MathUtils.degToRad(15);
  const SAFE_FACTOR = 1.0;  // keep-clear distance, in (sum of the two body lengths)
  const AVOID_WEIGHT = 4;
  const BRAKE = 0.5;        // how much a whale slows down for an imminent close pass

  let reducedMotion = false;

  function setReducedMotion(value) {
    reducedMotion = !!value;
  }

  function wrapAngle(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  // start: {x, y}; options: { heading, speed, bodyLength }.
  function createState(index, start, baseZ, options) {
    return {
      index,
      x: start.x,
      y: start.y,
      baseZ: baseZ || 0,
      heading: options.heading || 0,
      speed: options.speed,
      bodyLength: options.bodyLength,
      turnRate: 0,
      jumping: false,
      jumpStart: 0,
      jumpHeading: 0,
      jumpX: 0,
      jumpY: 0,
      jumpZ: 0,             // last jump height, to spot surface crossings
      jumpRoll: 1,          // which side the whale twists towards
      splash: null,
    };
  }

  // area: convex polygon [{x, y}, ...] of the water visible on screen (or null).
  function inside(area, x, y) {
    let sign = 0;
    for (let i = 0; i < area.length; i++) {
      const a = area[i];
      const b = area[(i + 1) % area.length];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cross === 0) continue;
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  }

  function centroid(area) {
    let x = 0;
    let y = 0;
    for (const p of area) { x += p.x; y += p.y; }
    return { x: x / area.length, y: y / area.length };
  }

  // Advances every whale by dt seconds. Jumping whales stay in place (they
  // are still obstacles for the others).
  function step(states, t, dt, area) {
    if (reducedMotion || dt <= 0) return;
    const center = area ? centroid(area) : null;

    for (const s of states) {
      if (s.jumping) continue;
      const dirX = Math.cos(s.heading);
      const dirY = Math.sin(s.heading);
      const vx = dirX * s.speed;
      const vy = dirY * s.speed;

      // Edges of the visible sea: look ahead, turn back towards the middle.
      // This takes priority over the meander.
      let wall = 0;
      if (area) {
        const look = s.bodyLength * 2;
        const aheadOut = !inside(area, s.x + dirX * look, s.y + dirY * look);
        const out = !inside(area, s.x, s.y);
        if (aheadOut || out) {
          const toCenter = wrapAngle(Math.atan2(center.y - s.y, center.x - s.x) - s.heading);
          wall = Math.sign(toCenter || 1) * MAX_TURN_RATE * (out ? 3 : 2);
        }
      }

      // Gentle meander, different for each whale.
      let wish = wall || (0.30 * Math.sin(t * 0.21 + s.index * 1.3)
        + 0.18 * Math.sin(t * 0.53 + s.index * 2.1));

      let brake = 0; // 0..1: ease off when a close pass is coming
      // Other whales: anticipate where each pair will be closest over the
      // next few seconds and turn away from that spot if it's too close.
      for (const o of states) {
        if (o === s) continue;
        const safe = (s.bodyLength + o.bodyLength) * SAFE_FACTOR;
        const rx = o.x - s.x;
        const ry = o.y - s.y;
        if (Math.hypot(rx, ry) > safe + 3 * (s.speed + o.speed)) continue;
        const ovx = o.jumping ? 0 : Math.cos(o.heading) * o.speed;
        const ovy = o.jumping ? 0 : Math.sin(o.heading) * o.speed;
        const rvx = ovx - vx;
        const rvy = ovy - vy;
        const rv2 = rvx * rvx + rvy * rvy;
        const tca = rv2 > 1e-9 ? THREE.MathUtils.clamp(-(rx * rvx + ry * rvy) / rv2, 0, 3) : 0;
        const cx = rx + rvx * tca;
        const cy = ry + rvy * tca;
        const dca = Math.hypot(cx, cy);
        if (dca >= safe) continue;
        const bearing = wrapAngle(Math.atan2(cy, cx) - s.heading);
        if (Math.abs(bearing) > THREE.MathUtils.degToRad(120)) continue; // behind: its problem
        const weight = (1 - dca / safe) * (1 - tca / 4) * AVOID_WEIGHT;
        wish -= Math.sign(bearing || 1) * MAX_TURN_RATE * weight;
        brake = Math.max(brake, weight / AVOID_WEIGHT);
      }

      wish = THREE.MathUtils.clamp(wish, -MAX_TURN_RATE, MAX_TURN_RATE);
      s.turnRate += (wish - s.turnRate) * Math.min(1, dt * TURN_EASE);
      s.heading = wrapAngle(s.heading + s.turnRate * dt);
      // Slightly slower in tight turns, like a real animal.
      const speed = s.speed * (1 - 0.3 * Math.abs(s.turnRate) / MAX_TURN_RATE) * (1 - BRAKE * brake);
      s.x += Math.cos(s.heading) * speed * dt;
      s.y += Math.sin(s.heading) * speed * dt;
    }

    // Last resort: never let two bodies overlap, even when steering was too
    // slow to avoid it (nudge both apart a little).
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        const a = states[i];
        const b = states[j];
        const min = (a.bodyLength + b.bodyLength) * 0.45;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= min || d === 0) continue;
        const push = (min - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        if (!a.jumping) { a.x -= ux * push; a.y -= uy * push; }
        if (!b.jumping) { b.x += ux * push; b.y += uy * push; }
      }
    }

    // Likewise never drift more than half a body off the visible sea.
    if (area) {
      for (const s of states) {
        if (s.jumping) continue;
        const limit = s.bodyLength * 0.5;
        for (let i = 0; i < area.length; i++) {
          const a = area[i];
          const b = area[(i + 1) % area.length];
          const ex = b.x - a.x;
          const ey = b.y - a.y;
          const len = Math.hypot(ex, ey);
          // Outward distance from this edge (positive = outside), for a
          // polygon wound either way (checked against the centroid).
          const side = Math.sign((ex * (center.y - a.y) - ey * (center.x - a.x)) || 1);
          const outward = -side * (ex * (s.y - a.y) - ey * (s.x - a.x)) / len;
          if (outward > limit) {
            const nx = -side * ey / len; // inward unit normal
            const ny = side * ex / len;
            s.x += nx * (outward - limit);
            s.y += ny * (outward - limit);
          }
        }
      }
    }
  }

  // Called on every tap; starts a jump only if the whale is swimming.
  function startJump(state, t) {
    if (state.jumping) return;
    state.jumping = true;
    state.jumpStart = t;
    state.jumpHeading = state.heading;
    state.jumpX = state.x;
    state.jumpY = state.y;
    state.jumpZ = 0;
    state.jumpRoll = state.index % 2 ? -1 : 1;
    state.turnRate = 0;
    state.splash = null;
  }

  // Smooth curve through keys (cubic Hermite, Catmull-Rom tangents inside,
  // flat at both ends): value and slope (per unit of u).
  function smoothKeys(k, u) {
    let i = 0;
    while (i < k.length - 2 && u > k[i + 1][0]) i++;
    const [t0, p0] = k[i];
    const [t1, p1] = k[i + 1];
    const slope = (j) => (j === 0 || j === k.length - 1)
      ? 0 : (k[j + 1][1] - k[j - 1][1]) / (k[j + 1][0] - k[j - 1][0]);
    const h = t1 - t0;
    const x = THREE.MathUtils.clamp((u - t0) / h, 0, 1);
    const m0 = slope(i) * h;
    const m1 = slope(i + 1) * h;
    const x2 = x * x;
    const x3 = x2 * x;
    const value = (2 * x3 - 3 * x2 + 1) * p0 + (x3 - 2 * x2 + x) * m0 + (-2 * x3 + 3 * x2) * p1 + (x3 - x2) * m1;
    const derivative = ((6 * x2 - 6 * x) * p0 + (3 * x2 - 4 * x + 1) * m0 + (-6 * x2 + 6 * x) * p1 + (3 * x2 - 2 * x) * m1) / h;
    return { value, derivative };
  }

  // Forward speed through the jump, as a multiple of the cruising speed:
  // 1 + BOOST * sin^2(pi u), so it surges in the middle and blends back.
  const BOOST = 1.3;
  function jumpDistance(u, speed) {
    // integral of speed * (1 + BOOST sin^2(pi u)) over the jump time
    return speed * JUMP_DURATION * (u + BOOST * (u / 2 - Math.sin(2 * Math.PI * u) / (4 * Math.PI)));
  }

  // Jump pose: a smooth arc along the heading the whale had when tapped.
  // The nose follows the direction of travel (up out of the water, down back
  // in), the body twists onto its side in the air, and the fluke beats hard
  // on the way up and rests in the air (`stroke`).
  function jumpPose(state, t, maxPitchDeg) {
    const elapsed = t - state.jumpStart;
    const u = THREE.MathUtils.clamp(elapsed / JUMP_DURATION, 0, 1);
    // Higher jumps for the whales that pitch up more (the blue whale barely
    // clears the water).
    const scale = (maxPitchDeg == null ? 55 : maxPitchDeg) / 55;
    const z = smoothKeys(JUMP_KEYS, u).value * scale;
    const pitch = smoothKeys(PITCH_KEYS, u).value * THREE.MathUtils.degToRad(maxPitchDeg == null ? 55 : maxPitchDeg);

    const distance = jumpDistance(u, state.speed);
    const x = state.jumpX + Math.cos(state.jumpHeading) * distance;
    const y = state.jumpY + Math.sin(state.jumpHeading) * distance;

    // Twist onto the side while airborne, back upright under water
    const air = THREE.MathUtils.clamp((u - 0.36) / 0.52, 0, 1);
    const roll = state.jumpRoll * THREE.MathUtils.degToRad(70) * scale * Math.sin(Math.PI * air) ** 2;

    // Fluke: hard strokes while gaining speed, still in the air
    const out = THREE.MathUtils.smoothstep(u, 0.36, 0.44) * (1 - THREE.MathUtils.smoothstep(u, 0.68, 0.78));
    const stroke = (1 + 1.2 * Math.sin(Math.PI * THREE.MathUtils.clamp(u / 0.42, 0, 1))) * (1 - 0.8 * out);

    // Splash where the body actually crosses the surface: out, then back in
    // (harder, and again from the tail a moment later).
    const surface = SURFACE + state.baseZ;
    const previous = state.jumpZ;
    const current = state.baseZ + z;
    if (previous < surface && current >= surface) {
      state.splash = { x, y, radius: 0.04, strength: 0.03 };
    } else if (previous > surface && current <= surface) {
      state.splash = { x, y, radius: 0.07, strength: 0.06 };
    }
    state.jumpZ = current;
    state.x = x;
    state.y = y;

    return {
      x, y, z: current,
      heading: state.jumpHeading,
      pitch,
      roll,
      steer: 0,
      stroke,
      done: elapsed >= JUMP_DURATION,
    };
  }

  // Splash to show this frame (surface crossing during a jump), if any.
  function checkSplash(state) {
    const splash = state.splash;
    state.splash = null;
    return splash;
  }

  // Current pose to apply to the whale (after step()).
  function updatePose(state, t, maxPitchDeg) {
    if (state.jumping) {
      if (reducedMotion) {
        // Reduced motion: no leap, just a short roll at the surface.
        const elapsed = t - state.jumpStart;
        if (elapsed >= JUMP_DURATION) state.jumping = false;
        const roll = elapsed < JUMP_DURATION
          ? Math.sin(elapsed * Math.PI * 2) * THREE.MathUtils.degToRad(6) : 0;
        return { x: state.x, y: state.y, z: state.baseZ, heading: state.heading, roll, steer: 0 };
      }
      const pose = jumpPose(state, t, maxPitchDeg);
      if (!pose.done) return pose;
      // Resume swimming from where it landed, same heading and speed.
      state.jumping = false;
    }
    const steer = state.turnRate / MAX_TURN_RATE;
    return {
      x: state.x,
      y: state.y,
      z: state.baseZ,
      heading: state.heading,
      // Positive roll drops the right side, so a left turn (steer > 0) banks negative.
      tilt: -steer * BANK,
      steer,
    };
  }

  return {
    createState,
    step,
    startJump,
    jumpPose,
    checkSplash,
    updatePose,
    setReducedMotion,
    JUMP_DURATION,
  };
})();

if (typeof window !== 'undefined') window.WhaleState = WhaleState;
