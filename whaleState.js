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
  const JUMP_DURATION = 1.4; // seconds
  const SPLASH_TIMES = [0.30, 0.85]; // seconds into the jump
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
      lastSplashIndex: -1,
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
    state.turnRate = 0;
    state.lastSplashIndex = -1;
  }

  // Jump: pure function of elapsed time, in place (height/pitch/roll only).
  function jumpPose(state, t, maxPitchDeg) {
    const elapsed = t - state.jumpStart;
    const u = THREE.MathUtils.clamp(elapsed / JUMP_DURATION, 0, 1);
    const arc = Math.sin(u * Math.PI);
    const pitchDeg = maxPitchDeg == null ? 46 : maxPitchDeg;
    return {
      x: state.x,
      y: state.y,
      z: state.baseZ + arc * 0.12,
      heading: state.jumpHeading,
      pitch: arc * THREE.MathUtils.degToRad(pitchDeg),
      roll: Math.sin(u * Math.PI * 2) * THREE.MathUtils.degToRad(8),
      steer: 0,
      done: elapsed >= JUMP_DURATION,
    };
  }

  // Splashes at fixed instants of the jump (water exit / entry).
  function checkSplash(state, t) {
    if (!state.jumping) return null;
    const elapsed = t - state.jumpStart;
    for (let i = 0; i < SPLASH_TIMES.length; i++) {
      if (i <= state.lastSplashIndex) continue;
      if (elapsed >= SPLASH_TIMES[i]) {
        state.lastSplashIndex = i;
        return { x: state.x, y: state.y };
      }
    }
    return null;
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
      state.jumping = false; // resume swimming from where it jumped
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
