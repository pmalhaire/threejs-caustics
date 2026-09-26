"""
Procedural whale mesh generator for the Baleines project (own creation, no
external assets). Builds a whale oriented head +Y, back +Z, about unit
length, ready for whale_pipeline.py (normalise() fixes the exact scale and
centering).

Shapes follow reference photos and profile illustrations of each species
(Wikimedia Commons).

The whale is ONE closed quad surface, modelled like a subdivision cage and
smoothed by one Catmull-Clark level:
  - the body is a loft of rings (dorsal/ventral/width profiles along the
    length, per-station cross-section shape), rings spaced evenly and their
    vertices spaced evenly by arc length, so the quads are regular;
  - pectoral fins, dorsal fin and fluke halves are extruded from body faces
    (no separate shells): the subdivision rounds the junctions into fillets;
  - the tail stock flattens and widens into the fluke root, the flukes grow
    out of its sides.

Run inside Blender:
    blender --background --python whale_gen.py -- humpback
"""
import bisect
import math
import sys

import bmesh
import bpy
from mathutils import Vector

M = 4                  # vertices per quadrant of a body ring
S = 4 * M              # vertices per body ring
INFLATE = 1.02         # one Catmull-Clark level shrinks a 16-gon by about 2%


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------

def curve(points):
    """Smooth (Catmull-Rom) interpolation through control points [(s, v), ...]."""
    xs = [p[0] for p in points]
    vs = [p[1] for p in points]

    def value(s):
        if s <= xs[0]:
            return vs[0]
        if s >= xs[-1]:
            return vs[-1]
        i = max(k for k in range(len(xs) - 1) if xs[k] <= s)
        t = (s - xs[i]) / (xs[i + 1] - xs[i])
        p0 = vs[max(i - 1, 0)]
        p1, p2 = vs[i], vs[i + 1]
        p3 = vs[min(i + 2, len(vs) - 1)]
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                      + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
    return value


def quadrant(w, h, n, taper=None):
    """M points on the quarter superellipse from the side (x = w) to the
    midline (z = h), evenly spaced by arc length. n: 2 = ellipse, higher =
    boxier, lower = pinched (keel). taper(sin) narrows x (lower jaw)."""
    samples = []
    for i in range(97):
        phi = 0.5 * math.pi * i / 96
        c, s = math.cos(phi), math.sin(phi)
        x = w * c ** (2.0 / n)
        if taper:
            x *= taper(s)
        samples.append((x, h * s ** (2.0 / n)))
    lengths = [0.0]
    for a, b in zip(samples, samples[1:]):
        lengths.append(lengths[-1] + math.dist(a, b))
    points = []
    for j in range(M):
        target = lengths[-1] * (j + 0.5) / M
        i = min(bisect.bisect_right(lengths, target) - 1, len(samples) - 2)
        f = (target - lengths[i]) / max(lengths[i + 1] - lengths[i], 1e-9)
        (x0, z0), (x1, z1) = samples[i], samples[i + 1]
        points.append((x0 + (x1 - x0) * f, z0 + (z1 - z0) * f))
    # The side and the midline fall between two vertices (on a face centre),
    # which would shave the profile, most on keeled (pinched) sections:
    # stretch so the outermost vertices reach the requested width and height.
    sx = samples[0][0] / max(points[0][0], 1e-9)
    sz = h / max(points[-1][1], 1e-9)
    return [(x * sx, z * sz) for x, z in points]


# ---------------------------------------------------------------------------
# Body rings
# ---------------------------------------------------------------------------
# Ring vertex k: 0..M-1 upper right (side -> top), M..2M-1 upper left
# (top -> side), 2M..3M-1 lower left (side -> bottom), 3M..4M-1 lower right
# (bottom -> side). Face column k joins vertices k and k+1:
#   S-1 right side, M-1 top, 2M-1 left side, 3M + M/2 - 1 lower right flank.
# The mirror of face column k is 2M-2-k (mod S).

RIGHT_SIDE = S - 1
LEFT_SIDE = 2 * M - 1
TOP = M - 1
LOWER_FLANK = 3 * M + M // 2 - 1


def mirror(k):
    return (2 * M - 2 - k) % S


def ring_stations(s_end, forced, ds):
    """Stations from the snout (0) to s_end, spaced about ds apart, with
    rings exactly on the `forced` stations (fin roots, fluke root, knuckles)."""
    fixed = sorted({0.0, s_end, *[round(s, 5) for s in forced]})
    out = []
    for a, b in zip(fixed, fixed[1:]):
        n = max(1, round((b - a) / ds))
        out += [a + (b - a) * i / n for i in range(n)]
    return out + [s_end]


def index_of(stations, s):
    return min(range(len(stations)), key=lambda i: abs(stations[i] - s))


def build_body(bm, spec, stations, holes):
    """Loft of rings; faces listed in `holes` ((ring, column) pairs) are left
    open for the extrusions. Returns the ring vertex lists."""
    top, bottom, width = curve(spec['top']), curve(spec['bottom']), curve(spec['width'])
    shape = curve(spec['shape'])
    belly_shape = curve(spec.get('belly_shape', spec['shape']))
    jaw = curve(spec.get('jaw_width', [(0, 1.0), (1, 1.0)]))
    bumps = spec.get('bumps', [])

    rings = []
    for s in stations:
        jaw_w = jaw(s)
        upper = quadrant(width(s), top(s), shape(s))
        lower = quadrant(width(s), bottom(s), belly_shape(s),
                         taper=lambda sn, j=jaw_w: 1 - (1 - j) * min(1.0, sn * 1.6))
        points = (upper + [(-x, z) for x, z in reversed(upper)]
                  + [(-x, -z) for x, z in lower] + [(x, -z) for x, z in reversed(lower)])
        ring = []
        for x, z in points:
            if z > 0:
                for (sc, sw, height, xw) in bumps:
                    z += height * math.exp(-((s - sc) / sw) ** 2) * math.exp(-(x / xw) ** 2)
            ring.append(bm.verts.new((x * INFLATE, 0.5 - s, z * INFLATE)))
        rings.append(ring)

    for r in range(len(rings) - 1):
        for k in range(S):
            if (r, k) not in holes:
                j = (k + 1) % S
                bm.faces.new((rings[r][k], rings[r][j], rings[r + 1][j], rings[r + 1][k]))

    # snout and tail: ladder of quads between the upper and lower halves
    for ring in (rings[0], rings[-1]):
        for i in range(S // 2 - 1):
            bm.faces.new((ring[i], ring[i + 1], ring[S - 2 - i], ring[S - 1 - i]))
    return rings


def root_loop(rings, r0, r1, k):
    """Boundary of the face column k between rings r0..r1: one side front to
    back, then the other side back to front."""
    j = (k + 1) % S
    return [rings[r][k] for r in range(r0, r1 + 1)] + [rings[r][j] for r in range(r1, r0 - 1, -1)]


# ---------------------------------------------------------------------------
# Extrusions: pectoral fins, dorsal fin, fluke halves
# ---------------------------------------------------------------------------

# half thickness across the chord (leading edge, [middle], trailing edge),
# inflated so the subdivided foil reaches the requested thickness
HALF_THICKNESS = {2: (0.46, 0.14), 3: (0.40, 0.60, 0.12)}


def extrude(bm, loop, span_dir, stations, chord_hint=(0, -1, 0), group=None):
    """Grow a foil out of the open `loop` (see root_loop) along span_dir.
    stations: (u, le, chord, thickness[, offset]) with u the distance from
    the root, le the leading edge offset from the root leading edge along the
    chord, offset an optional world-space shift (tip curl). The tip is closed."""
    rows = len(loop) // 2
    span = Vector(span_dir).normalized()
    chord_dir = Vector(chord_hint)
    chord_dir = (chord_dir - span * chord_dir.dot(span)).normalized()
    normal = span.cross(chord_dir).normalized()

    base = [v.co.copy() for v in loop]
    centre = sum(base, Vector()) / len(base)
    le0 = min((p - centre).dot(chord_dir) for p in base)
    side_a = 1 if sum((p - centre).dot(normal) for p in base[:rows]) > 0 else -1
    half = HALF_THICKNESS[rows]

    previous = loop
    for station in stations:
        u, le, chord, thick = station[:4]
        offset = Vector(station[4]) if len(station) > 4 else Vector()
        axis = centre + span * u + offset
        ring = []
        for i in range(len(loop)):
            row = i if i < rows else 2 * rows - 1 - i
            a = row / (rows - 1)
            side = side_a if i < rows else -side_a
            # stretch the chord a little: the subdivision pulls both edges in
            along = le0 + le + (-0.06 + 1.12 * a) * chord
            vertex = bm.verts.new(axis + chord_dir * along + normal * side * half[row] * thick)
            ring.append(vertex)
        for i in range(len(loop)):
            j = (i + 1) % len(loop)
            bm.faces.new((previous[i], previous[j], ring[j], ring[i]))
        if group is not None:
            for vertex in ring:
                group(vertex)
        previous = ring

    for i in range(rows - 1):
        bm.faces.new((previous[i], previous[i + 1],
                      previous[2 * rows - 2 - i], previous[2 * rows - 1 - i]))


def fin_stations(length, root_chord, tip_chord, thickness, sweep, tubercles=0.0, n=10):
    """Pectoral fin: chord narrows to a rounded tip, the leading edge sweeps
    back; optional knobbly leading edge (humpback tubercles)."""
    out = []
    for k in range(1, n + 1):
        t = k / n
        u = length * t * (1 + 0.4 / n)       # the subdivision rounds the tip off
        tip = math.sqrt(max(0.0, 1 - ((t - 0.75) / 0.25) ** 2)) if t > 0.75 else 1.0
        chord = (root_chord + (tip_chord - root_chord) * t) * max(tip, 0.3)
        le = sweep * length * t ** 1.3 + (root_chord - chord) * 0.4
        if tubercles and k < n:
            le += tubercles * (k % 2)
        out.append((u, le, chord, thickness * (1 - 0.6 * t) * max(tip, 0.45)))
    return out


def fluke_stations(extent, root_chord, le_tip, notch, thickness, serrations=0.0, n=9, lift=0.0,
                   le_power=1.5, te_power=2.0):
    """One fluke half: the leading edge sweeps back to a pointed tip; the
    trailing edge steps back from the median notch then runs nearly straight
    to the tip; optional serrated trailing edge (humpback); tips lifted by
    `lift` (flukes are not flat plates)."""
    out = []
    for k in range(1, n + 1):
        t = k / n
        u = extent * t * (1 + 0.3 / n)
        le = le_tip * t ** le_power
        te = root_chord + notch * min(1.0, t / 0.2) + (le_tip - root_chord - notch) * t ** te_power
        chord = max(te - le, 0.010)
        if serrations and 0.15 < t < 0.9:
            chord += serrations * (1 if k % 2 else -1)
        out.append((u, le, chord, thickness * (1 - 0.75 * t ** 0.8), (0, 0, lift * t * t)))
    return out


# ---------------------------------------------------------------------------
# Species (lengths as fractions of the snout-to-notch length, snout s = 0)
# ---------------------------------------------------------------------------

def humpback():
    # Stocky (depth about a fifth of the length), flat head, deep throat,
    # small dorsal fin on a hump two-thirds back, knobbly tail stock; very
    # long narrow flippers with a knobbly leading edge; broad flukes with
    # swept-back pointed tips and a serrated trailing edge.
    return dict(
        s_end=0.88, ds=0.034,
        top=[(0, 0.012), (0.03, 0.024), (0.08, 0.037), (0.16, 0.052), (0.26, 0.067),
             (0.36, 0.078), (0.46, 0.086), (0.55, 0.087), (0.64, 0.080), (0.72, 0.063),
             (0.77, 0.050), (0.81, 0.038), (0.845, 0.024), (0.88, 0.013)],
        bottom=[(0, 0.014), (0.03, 0.032), (0.08, 0.050), (0.16, 0.070), (0.26, 0.089),
                (0.36, 0.100), (0.46, 0.100), (0.55, 0.090), (0.64, 0.072), (0.72, 0.054),
                (0.77, 0.042), (0.81, 0.032), (0.845, 0.020), (0.88, 0.011)],
        width=[(0, 0.014), (0.03, 0.042), (0.08, 0.064), (0.16, 0.080), (0.26, 0.094),
               (0.36, 0.102), (0.46, 0.104), (0.55, 0.096), (0.64, 0.076), (0.72, 0.050),
               (0.77, 0.032), (0.81, 0.026), (0.845, 0.030), (0.88, 0.024)],
        # flat head, round body, keeled tail stock, flat fluke root
        shape=[(0, 2.8), (0.2, 2.4), (0.55, 2.1), (0.74, 1.7), (0.80, 1.8), (0.88, 2.4)],
        belly_shape=[(0, 2.2), (0.55, 2.1), (0.74, 1.7), (0.80, 1.8), (0.88, 2.4)],
        bumps=[(0.62, 0.05, 0.010, 0.030),                     # hump under the dorsal fin
               (0.72, 0.012, 0.006, 0.012), (0.765, 0.012, 0.005, 0.010),  # knuckles
               (0.10, 0.08, 0.005, 0.010)],                    # rostral ridge
        knuckles=[0.72, 0.765],
        dorsal=dict(s=0.60, root_chord=0.060, height=0.030, tip_chord=0.014, sweep=0.8,
                    thickness=0.012),
        fin=dict(s=0.27, root_chord=0.074, length=0.30, tip_chord=0.034, thickness=0.020,
                 sweep=0.05, tubercles=0.005, span_dir=(0.60, -0.40, -0.70), n=12),
        fluke=dict(root_chord=0.07, half_span=0.18, le_tip=0.13, notch=0.014,
                   thickness=0.030, serrations=0.0035, n=10, lift=0.012),
    )


def blue():
    # Long and slender (depth about an eighth of the length), broad flat
    # U-shaped head with a median ridge and a raised splash guard at the
    # blowholes, tiny dorsal fin far back, small pointed flippers, long thin
    # tail stock, relatively small triangular flukes.
    return dict(
        s_end=0.90, ds=0.034,
        top=[(0, 0.006), (0.02, 0.011), (0.07, 0.020), (0.14, 0.028), (0.22, 0.036),
             (0.32, 0.043), (0.44, 0.046), (0.56, 0.043), (0.66, 0.036), (0.75, 0.027),
             (0.82, 0.023), (0.855, 0.018), (0.8775, 0.012), (0.90, 0.007)],
        bottom=[(0, 0.006), (0.02, 0.016), (0.07, 0.030), (0.14, 0.042), (0.22, 0.052),
                (0.32, 0.057), (0.44, 0.055), (0.56, 0.047), (0.66, 0.037), (0.75, 0.026),
                (0.82, 0.020), (0.855, 0.015), (0.8775, 0.010), (0.90, 0.006)],
        width=[(0, 0.016), (0.02, 0.034), (0.07, 0.052), (0.14, 0.062), (0.22, 0.068),
               (0.32, 0.072), (0.44, 0.071), (0.56, 0.062), (0.66, 0.046), (0.75, 0.028),
               (0.82, 0.016), (0.855, 0.018), (0.8775, 0.021), (0.90, 0.017)],
        # flat, broad head, round body, keeled tail stock, flat fluke root
        shape=[(0, 3.0), (0.18, 2.6), (0.35, 2.2), (0.72, 1.9), (0.82, 1.7), (0.90, 2.4)],
        belly_shape=[(0, 2.4), (0.35, 2.1), (0.72, 1.9), (0.82, 1.7), (0.90, 2.4)],
        bumps=[(0.20, 0.018, 0.009, 0.020),                    # splash guard at the blowholes
               (0.10, 0.07, 0.004, 0.008)],                    # median rostral ridge
        dorsal=dict(s=0.75, root_chord=0.036, height=0.022, tip_chord=0.009, sweep=1.0,
                    thickness=0.008),
        fin=dict(s=0.26, root_chord=0.034, length=0.12, tip_chord=0.010, thickness=0.011,
                 sweep=0.10, span_dir=(0.72, -0.45, -0.52), n=6),
        fluke=dict(root_chord=0.054, half_span=0.13, le_tip=0.080, notch=0.008,
                   thickness=0.020, n=8, le_power=1.1, te_power=1.0, lift=0.006),
    )


def sperm():
    # Huge block head (a third of the length), blunt vertical front, narrow
    # underslung lower jaw set back from the front; low triangular hump
    # two-thirds back then a row of knuckles; small paddle flippers; broad
    # triangular flukes with a straight trailing edge and a deep notch.
    return dict(
        s_end=0.88, ds=0.034,
        top=[(0, 0.052), (0.01, 0.074), (0.03, 0.082), (0.12, 0.086), (0.24, 0.087),
             (0.34, 0.082), (0.44, 0.075), (0.54, 0.068), (0.62, 0.062), (0.70, 0.047),
             (0.76, 0.036), (0.81, 0.028), (0.845, 0.017), (0.88, 0.009)],
        bottom=[(0, 0.016), (0.01, 0.034), (0.03, 0.046), (0.10, 0.060), (0.20, 0.072),
                (0.32, 0.082), (0.44, 0.084), (0.54, 0.077), (0.62, 0.066), (0.70, 0.050),
                (0.76, 0.037), (0.81, 0.025), (0.845, 0.014), (0.88, 0.008)],
        width=[(0, 0.038), (0.01, 0.054), (0.03, 0.060), (0.12, 0.064), (0.24, 0.068),
               (0.34, 0.072), (0.44, 0.074), (0.54, 0.068), (0.62, 0.058), (0.70, 0.044),
               (0.76, 0.030), (0.81, 0.026), (0.845, 0.031), (0.88, 0.025)],
        # very boxy head, softer body, keeled tail stock, flat fluke root
        shape=[(0, 4.0), (0.28, 3.4), (0.40, 2.3), (0.62, 2.0), (0.76, 1.7), (0.81, 1.8),
               (0.88, 2.4)],
        belly_shape=[(0, 2.4), (0.3, 2.2), (0.62, 2.0), (0.76, 1.7), (0.81, 1.8), (0.88, 2.4)],
        # narrow lower jaw under the head
        jaw_width=[(0, 0.35), (0.22, 0.45), (0.34, 0.9), (0.4, 1.0)],
        bumps=[(0.63, 0.035, 0.016, 0.028),                    # low triangular hump
               (0.695, 0.012, 0.010, 0.012), (0.73, 0.012, 0.008, 0.011),
               (0.765, 0.012, 0.006, 0.010)],                  # knuckles
        knuckles=[0.695, 0.73, 0.765],
        fin=dict(s=0.36, root_chord=0.040, length=0.075, tip_chord=0.030, thickness=0.013,
                 sweep=0.02, span_dir=(0.70, -0.35, -0.62), n=5),
        fluke=dict(root_chord=0.07, half_span=0.145, le_tip=0.105, notch=0.026,
                   thickness=0.028, n=9, le_power=1.3, te_power=1.4, lift=0.008),
    )


SPECIES_BUILDERS = {'humpback': humpback, 'blue': blue, 'sperm': sperm}


def root_rings(s, chord, ds):
    """Ring indices covered by a fin root starting at s (2 or 3 rows)."""
    return [s, s + chord / 2, s + chord] if chord > 1.5 * ds else [s, s + chord]


def build_whale(species_key):
    spec = SPECIES_BUILDERS[species_key]()
    s_end, ds = spec['s_end'], spec['ds']
    fin, fluke, dorsal = spec['fin'], spec['fluke'], spec.get('dorsal')

    fin_rows = root_rings(fin['s'], fin['root_chord'], ds)
    fluke_rows = root_rings(s_end - fluke['root_chord'], fluke['root_chord'], ds)
    dorsal_rows = root_rings(dorsal['s'], dorsal['root_chord'], ds) if dorsal else []
    stations = ring_stations(s_end, fin_rows + fluke_rows + dorsal_rows + spec.get('knuckles', []), ds)

    def span_of(rows):
        return index_of(stations, rows[0]), index_of(stations, rows[-1])

    fin_r = span_of(fin_rows)
    fluke_r = span_of(fluke_rows)
    dorsal_r = span_of(dorsal_rows) if dorsal else None
    columns = [(fin_r, LOWER_FLANK), (fin_r, mirror(LOWER_FLANK)),
               (fluke_r, RIGHT_SIDE), (fluke_r, LEFT_SIDE)]
    if dorsal:
        columns.append((dorsal_r, TOP))
    holes = {(r, k) for (r0, r1), k in columns for r in range(r0, r1)}

    bm = bmesh.new()
    deform = bm.verts.layers.deform.verify()
    rings = build_body(bm, spec, stations, holes)

    def tag(group_index):
        def apply(vertex):
            vertex[deform][group_index] = 1.0
        return apply

    # Pectoral fins, low on the flanks behind the eye, drooping back.
    dx, dy, dz = fin['span_dir']
    for group_index, (sign, column) in enumerate(((1, LOWER_FLANK), (-1, mirror(LOWER_FLANK)))):
        extrude(bm, root_loop(rings, *fin_r, column), (sign * dx, dy, dz),
                fin_stations(fin['length'], fin['root_chord'], fin['tip_chord'], fin['thickness'],
                             fin['sweep'], fin.get('tubercles', 0.0), fin['n']),
                group=tag(group_index))

    # Fluke halves, out of the flattened sides of the tail stock.
    root_x = curve(spec['width'])(s_end - fluke['root_chord'] / 2) * INFLATE
    for sign, column in ((1, RIGHT_SIDE), (-1, LEFT_SIDE)):
        extrude(bm, root_loop(rings, *fluke_r, column), (sign, 0, 0),
                fluke_stations(fluke['half_span'] - root_x, fluke['root_chord'], fluke['le_tip'],
                               fluke['notch'], fluke['thickness'], fluke.get('serrations', 0.0),
                               fluke['n'], fluke.get('lift', 0.0), fluke.get('le_power', 1.5),
                               fluke.get('te_power', 2.0)))

    # Dorsal fin, swept back.
    if dorsal:
        n = 4
        dorsal_stations = []
        for k in range(1, n + 1):
            t = k / n
            chord = dorsal['root_chord'] + (dorsal['tip_chord'] - dorsal['root_chord']) * t ** 0.8
            # falcate: the leading edge runs back faster than the trailing edge
            dorsal_stations.append((dorsal['height'] * t * 1.15, dorsal['root_chord'] * 0.25 * t,
                             chord, dorsal['thickness'] * (1 - 0.5 * t)))
        extrude(bm, root_loop(rings, *dorsal_r, TOP), (0, -dorsal['sweep'], 1), dorsal_stations)

    mesh = bpy.data.meshes.new(species_key + '_mesh')
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = bpy.data.objects.new(species_key, mesh)
    bpy.context.scene.collection.objects.link(obj)
    # fin vertices, so the pipeline can place the fin bones on the real fins
    obj.vertex_groups.new(name='fin_shape.L')
    obj.vertex_groups.new(name='fin_shape.R')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    cage = len(mesh.polygons)
    subsurf = obj.modifiers.new('Subdivision', 'SUBSURF')
    subsurf.levels = subsurf.render_levels = 1
    bpy.ops.object.modifier_apply(modifier=subsurf.name)
    bpy.ops.object.shade_smooth()

    mesh = obj.data
    tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
    print('[whale_gen] built', species_key, 'cage quads:', cage, 'triangles:', tris,
          'verts:', len(mesh.vertices), 'rings:', len(stations))
    return obj


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['humpback']
    species_key = args[0]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    build_whale(species_key)
