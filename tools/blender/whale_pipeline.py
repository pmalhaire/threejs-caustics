"""
Baleines - whale asset pipeline for Blender (4.2+ / 5.x).

Turns a whale mesh into an app-ready GLB:
  1. normalise: origin at the body centre, length 1.0, head towards +Y, back towards +Z
  2. decimate to <= TARGET_TRIS triangles
  3. armature: 'body' + spine chain to the fluke + 2 pectoral fins (8 bones)
  4. skin weights: automatic (bone heat), with a spine-only fallback, max 4 influences
  5. 'idle' action: slow dorso-ventral (up/down) undulation, seamless loop
  6. vertex colours: dark back, light belly (+ white flippers for the humpback)
  7. export GLB (+Y up, glTF convention) and print the acceptance checks

Use from the Blender UI or the Blender MCP connector: select the whale mesh, adjust
SETTINGS below, run the script. From a terminal:
    blender whale.blend --background --python whale_pipeline.py -- --species humpback --out humpback.glb

The jump is NOT in the file: the app drives it from code. Only 'idle' is exported.
Written for this project, not yet run: check the printed report and the viewport.
"""

import json
import math
import os
import struct
import sys

import bpy
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

SETTINGS = {
    'species': 'humpback',        # humpback | blue | sperm
    'out': '//humpback.glb',      # '//' = next to the .blend file
    'target_tris': 6000,          # app budget per whale
    'head_axis': 'auto',          # 'auto' or one of +X -X +Y -Y +Z -Z (where the head points)
    'up_axis': '+Z',              # where the back points in the source model
    'idle_seconds': 2.4,          # loop duration
    'fps': 25,
}

# Species shape hints (fractions of body length, from the head). Approximate
# biology: humpback flippers are up to a third of the body length and white;
# blue whale flippers are short and the whale is uniformly blue-grey; the sperm
# whale is dark grey with small flippers.
# Colours from reference photos. Optional pattern keys used by paint():
#   white_fins  flippers lighten towards the belly colour (humpback)
#   throat      (from, to) head-relative range where the belly colour shows
#               (humpback: white throat and chest, dark elsewhere underneath)
#   mottle      strength of blotchy light/dark patches (blue whale)
#   lips        lighter mouth line and jaw (sperm whale)
SPECIES = {
    'humpback': {'fin_root': 0.28, 'fin_length': 0.30, 'white_fins': True,
                 'back': (0.07, 0.08, 0.10), 'belly': (0.86, 0.88, 0.89),
                 'throat': (0.02, 0.62), 'mottle': 0.08},
    'blue':     {'fin_root': 0.26, 'fin_length': 0.12, 'white_fins': False,
                 'back': (0.27, 0.36, 0.46), 'belly': (0.38, 0.46, 0.54),
                 'mottle': 0.35},
    'sperm':    {'fin_root': 0.36, 'fin_length': 0.075, 'white_fins': False,
                 'back': (0.19, 0.19, 0.21), 'belly': (0.27, 0.27, 0.29),
                 'mottle': 0.2, 'lips': True},
    'classic':  {'fin_root': 0.30, 'fin_length': 0.22, 'white_fins': False,
                 'back': (0.15, 0.18, 0.22), 'belly': (0.55, 0.58, 0.62)},
}

# Idle undulation: amplitude (radians) per spine bone, head to tail, and the
# phase lag between consecutive bones (wave travelling towards the tail).
IDLE_AMPLITUDES = {'spine1': 0.013, 'spine2': 0.026, 'spine3': 0.043, 'spine4': 0.064, 'fluke': 0.102}
IDLE_PHASE_LAG = 0.6
FIN_FLAP = 0.06

# Acceptance limits (see the plan: gate A)
MAX_BONES = 16
MAX_BYTES = 250 * 1024
FLUKE_PEAK_TO_PEAK = (0.05, 0.08)  # fraction of body length


def parse_cli():
    """Override SETTINGS with `-- --species blue --out blue.glb` style arguments."""
    if '--' not in sys.argv:
        return
    args = sys.argv[sys.argv.index('--') + 1:]
    for i in range(0, len(args) - 1, 2):
        key = args[i].lstrip('-').replace('-', '_')
        if key in SETTINGS:
            SETTINGS[key] = type(SETTINGS[key])(args[i + 1])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

AXES = {'+X': Vector((1, 0, 0)), '-X': Vector((-1, 0, 0)), '+Y': Vector((0, 1, 0)),
        '-Y': Vector((0, -1, 0)), '+Z': Vector((0, 0, 1)), '-Z': Vector((0, 0, -1))}


def log(*parts):
    print('[baleines]', *parts)


def triangle_count(mesh):
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def guess_head_axis(mesh, up):
    """Longest axis orthogonal to `up`; the head is the end with the larger height
    (flukes are flat, heads are bulky)."""
    best = None
    for name, axis in AXES.items():
        if abs(axis.dot(up)) > 0.5 or name.startswith('-'):
            continue
        coords = [v.co.dot(axis) for v in mesh.vertices]
        extent = max(coords) - min(coords)
        if best is None or extent > best[1]:
            best = (name, extent, axis, min(coords), max(coords))
    name, extent, axis, lo, hi = best

    def height_near(end):
        span = [v.co.dot(up) for v in mesh.vertices if abs(v.co.dot(axis) - end) < 0.12 * extent]
        return (max(span) - min(span)) if span else 0.0

    return name if height_near(hi) >= height_near(lo) else '-' + name[1]


def normalise(obj):
    """Bake transforms, then rotate/scale/translate so the head is +Y, the back +Z,
    the bounding box centre at the origin and the length along Y equal to 1."""
    mesh = obj.data
    mesh.transform(obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)

    up = AXES[SETTINGS['up_axis']]
    head_name = SETTINGS['head_axis']
    if head_name == 'auto':
        head_name = guess_head_axis(mesh, up)
        log('head axis guessed:', head_name, '(set head_axis if wrong)')
    head = AXES[head_name]
    side = head.cross(up)
    # rows: new X, new Y, new Z expressed in old coordinates
    rotation = Matrix((side, head, up)).to_4x4()
    mesh.transform(rotation)

    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    centre = Vector(((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2, (max(zs) + min(zs)) / 2))
    length = max(ys) - min(ys)
    mesh.transform(Matrix.Scale(1.0 / length, 4) @ Matrix.Translation(-centre))
    mesh.update()
    log(f'normalised: length 1.0 (was {length:.3f}), head +Y, back +Z')


def decimate(obj, target):
    before = triangle_count(obj.data)
    if before <= target:
        log(f'triangles: {before} (no decimation needed)')
        return
    modifier = obj.modifiers.new('Decimate', 'DECIMATE')
    modifier.ratio = target / before * 0.97
    depsgraph = bpy.context.evaluated_depsgraph_get()
    new_mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    obj.modifiers.remove(modifier)
    old = obj.data
    obj.data = new_mesh
    bpy.data.meshes.remove(old)
    log(f'triangles: {before} -> {triangle_count(new_mesh)}')


def spine_height(mesh, y, band=0.05):
    """Median height of the vertices around station y (the body axis is rarely at z=0)."""
    zs = sorted(v.co.z for v in mesh.vertices if abs(v.co.y - y) < band)
    return zs[len(zs) // 2] if zs else 0.0


def half_width(mesh, y, band=0.03):
    xs = [abs(v.co.x) for v in mesh.vertices if abs(v.co.y - y) < band]
    return max(xs) if xs else 0.05


def fin_islands(obj):
    """Pectoral fin vertices: {'L': points, 'R': points} (L = +X side).
    whale_gen.py tags them in the 'fin_shape.L/R' vertex groups (the groups
    are removed here, they are not bones); otherwise, fins built as separate
    shells are found as connected components off the midline. Empty when
    neither applies (e.g. the classic model)."""
    mesh = obj.data
    tagged = {side: obj.vertex_groups.get('fin_shape.' + side) for side in ('L', 'R')}
    if all(tagged.values()):
        fins = {side: [v.co.copy() for v in mesh.vertices
                       if any(g.group == group.index and g.weight > 0.5 for g in v.groups)]
                for side, group in tagged.items()}
        for group in tagged.values():
            obj.vertex_groups.remove(group)
        return fins if all(fins.values()) else {}

    neighbours = {v.index: [] for v in mesh.vertices}
    for edge in mesh.edges:
        a, b = edge.vertices
        neighbours[a].append(b)
        neighbours[b].append(a)
    seen, islands = set(), []
    for start in neighbours:
        if start in seen:
            continue
        stack, island = [start], []
        seen.add(start)
        while stack:
            index = stack.pop()
            island.append(mesh.vertices[index].co.copy())
            for other in neighbours[index]:
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        islands.append(island)
    fins = {}
    for island in islands:
        cx = sum(p.x for p in island) / len(island)
        # pectoral fins sit well off the midline; body, flukes and dorsal fin don't
        if abs(cx) > 0.06:
            fins['L' if cx > 0 else 'R'] = island
    return fins if len(fins) == 2 else {}


def build_armature(obj, species):
    """8 bones: body (head part, rigid), spine1..spine4, fluke, fin.L, fin.R."""
    mesh = obj.data
    data = bpy.data.armatures.new(obj.name + '_rig')
    rig = bpy.data.objects.new(obj.name + '_rig', data)
    bpy.context.scene.collection.objects.link(rig)

    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')

    # stations along the body, head (+0.5) to tail (-0.5)
    stations = [('body', 0.40, 0.10), ('spine1', 0.10, -0.05), ('spine2', -0.05, -0.18),
                ('spine3', -0.18, -0.30), ('spine4', -0.30, -0.40), ('fluke', -0.40, -0.50)]
    previous = None
    for name, y0, y1 in stations:
        bone = data.edit_bones.new(name)
        if name == 'body':
            # points forward so the chain below starts at its root
            bone.head = (0, y1, spine_height(mesh, y1))
            bone.tail = (0, y0, spine_height(mesh, y0))
        else:
            bone.head = (0, y0, spine_height(mesh, y0))
            bone.tail = (0, y1, spine_height(mesh, y1))
            bone.parent = previous if previous.name != 'body' else data.edit_bones['body']
            bone.use_connect = previous.name != 'body'
        bone.roll = 0.0
        previous = bone

    islands = fin_islands(obj)
    y_root = 0.5 - species['fin_root']
    z_root = spine_height(mesh, y_root) - 0.03
    x_root = half_width(mesh, y_root, 0.02) * 0.6
    reach = species['fin_length']
    for side, sign in (('L', 1), ('R', -1)):
        fin = data.edit_bones.new('fin.' + side)
        if islands:
            # Follow the actual fin: root at its innermost vertices (at or
            # inside the body), tip at the farthest point from there.
            island = sorted(islands[side], key=lambda p: abs(p.x))
            inner = island[:max(3, len(island) // 10)]
            root = sum(inner, Vector()) / len(inner)
            tip = max(island, key=lambda p: (p - root).length)
            fin.head, fin.tail = root, tip
        else:
            fin.head = (sign * x_root, y_root, z_root)
            fin.tail = (sign * (x_root + reach * 0.8), y_root - reach * 0.5, z_root - reach * 0.15)
        fin.parent = data.edit_bones['body']
        fin.roll = 0.0

    bpy.ops.object.mode_set(mode='OBJECT')
    log(f'armature: {len(data.bones)} bones')
    return rig


def skin(obj, rig):
    """Automatic weights, then make sure every vertex is weighted by <= 4 bones."""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    automatic = True
    try:
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    except RuntimeError as error:
        automatic = False
        log('automatic weights failed:', error)

    if not automatic:
        obj.parent = rig
        modifier = obj.modifiers.new('Armature', 'ARMATURE')
        modifier.object = rig

    groups = {g.name: g for g in obj.vertex_groups}
    for bone in rig.data.bones:
        if bone.name not in groups:
            groups[bone.name] = obj.vertex_groups.new(name=bone.name)

    spine = [b for b in rig.data.bones if not b.name.startswith('fin')]
    fixed = 0
    for vertex in obj.data.vertices:
        weights = [(obj.vertex_groups[g.group].name, g.weight) for g in vertex.groups if g.weight > 0]
        if not weights:
            # spine-only fallback: nearest spine bone along the body
            nearest = min(spine, key=lambda b: abs((b.head_local.y + b.tail_local.y) / 2 - vertex.co.y))
            weights = [(nearest.name, 1.0)]
            fixed += 1
        weights = sorted(weights, key=lambda w: -w[1])[:4]
        total = sum(w for _, w in weights)
        for group_index in [g.group for g in vertex.groups]:
            obj.vertex_groups[group_index].remove([vertex.index])
        for name, weight in weights:
            groups[name].add([vertex.index], weight / total, 'REPLACE')
    log(f'weights: {"automatic" if automatic else "fallback"}; {fixed} vertices given a spine weight; max 4 influences')


def make_idle(rig):
    """Seamless loop: every bone angle is a sine of the loop phase."""
    scene = bpy.context.scene
    scene.render.fps = SETTINGS['fps']
    frames = round(SETTINGS['idle_seconds'] * SETTINGS['fps'])
    scene.frame_start, scene.frame_end = 1, frames + 1

    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    for bone in rig.pose.bones:
        bone.rotation_mode = 'XYZ'

    for frame in range(1, frames + 2):
        phase = 2 * math.pi * (frame - 1) / frames
        for index, (name, amplitude) in enumerate(IDLE_AMPLITUDES.items()):
            bone = rig.pose.bones[name]
            bone.rotation_euler = (amplitude * math.sin(phase - index * IDLE_PHASE_LAG), 0, 0)
            bone.keyframe_insert('rotation_euler', index=0, frame=frame)
        for name in ('fin.L', 'fin.R'):
            bone = rig.pose.bones[name]
            bone.rotation_euler = (FIN_FLAP * math.sin(phase + 1.0), 0, 0)
            bone.keyframe_insert('rotation_euler', index=0, frame=frame)
    bpy.ops.object.mode_set(mode='OBJECT')

    action = rig.animation_data.action
    action.name = 'idle'
    action.use_fake_user = True
    log(f'idle: {frames} frames at {SETTINGS["fps"]} fps ({frames / SETTINGS["fps"]:.2f} s), loops')

    # measure the fluke tip travel over the loop (acceptance check)
    heights = []
    for frame in range(1, frames + 2):
        scene.frame_set(frame)
        tail = rig.matrix_world @ rig.pose.bones['fluke'].tail
        heights.append(tail.z)
    scene.frame_set(1)
    return max(heights) - min(heights)


def noise3(p, scale):
    """Smooth value noise in [0, 1] (no external dependencies)."""
    x, y, z = p.x * scale, p.y * scale, p.z * scale
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    fx, fy, fz = (f * f * (3 - 2 * f) for f in (fx, fy, fz))

    def h(a, b, c):
        n = (a * 374761393 + b * 668265263 + c * 2147483647) & 0xFFFFFFFF
        n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
        return (n & 0xFFFF) / 65535.0

    def lerp(a, b, t):
        return a + (b - a) * t
    x0 = lerp(lerp(h(ix, iy, iz), h(ix + 1, iy, iz), fx), lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), fx), fy)
    x1 = lerp(lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), fx),
              lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), fx), fy)
    return lerp(x0, x1, fz)


def paint(obj, rig, species):
    """Vertex colours: back colour on top, belly colour underneath (by normal),
    plus per-species patterns (see SPECIES)."""
    mesh = obj.data
    attribute = mesh.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
    mesh.color_attributes.active_color = attribute
    try:
        mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
    except AttributeError:
        pass

    fin_groups = {obj.vertex_groups[n].index for n in ('fin.L', 'fin.R') if n in obj.vertex_groups}
    back, belly = Vector(species['back']), Vector(species['belly'])
    throat = species.get('throat')
    mottle = species.get('mottle', 0.0)
    for loop in mesh.loops:
        vertex = mesh.vertices[loop.vertex_index]
        p, n = vertex.co, vertex.normal
        s = 0.5 - p.y                                    # 0 at the snout, 1 at the tail
        underside = min(1.0, max(0.0, (-n.z - 0.1) / 0.4))
        if throat:
            # belly colour only on the throat and chest, with a ragged edge
            edge = throat[1] + (noise3(p, 18) - 0.5) * 0.12
            underside *= min(1.0, max(0.0, (edge - s) / 0.06)) * min(1.0, max(0.0, (s - throat[0]) / 0.03))
        color = back.lerp(belly, underside)
        fin = sum(g.weight for g in vertex.groups if g.group in fin_groups) if fin_groups else 0.0
        if species['white_fins'] and fin:
            # white flippers, with darker blotches on top
            blotch = noise3(p, 30) * max(0.0, n.z)
            color = color.lerp(belly, min(1.0, fin * 1.6)).lerp(back, 0.6 * blotch)
        if mottle:
            spots = noise3(p, 11) * 0.6 + noise3(p, 29) * 0.4
            color = color * (1.0 + mottle * (spots - 0.5) * 2)
        if species.get('lips'):
            # pale lower jaw and mouth line under the block head
            jaw = min(1.0, max(0.0, (-n.z - 0.3) / 0.4)) * (s < 0.34) * min(1.0, abs(p.x) < 0.035)
            color = color.lerp(Vector((0.72, 0.72, 0.72)), 0.8 * jaw)
        color = Vector([min(1.0, max(0.0, c)) for c in color])
        attribute.data[loop.index].color = (*color, 1.0)
    log('vertex colours painted')


def export(obj, rig, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig

    wanted = {
        'filepath': path, 'export_format': 'GLB', 'use_selection': True, 'export_yup': True,
        'export_apply': False, 'export_texcoords': False, 'export_normals': True,
        'export_materials': 'NONE', 'export_skins': True, 'export_def_bones': True,
        'export_influence_nb': 4, 'export_animations': True, 'export_animation_mode': 'ACTIONS',
        'export_force_sampling': True, 'export_optimize_animation_size': True,
        'export_reset_pose_bones': True, 'export_rest_position_armature': True,
        'export_vertex_color': 'ACTIVE', 'export_colors': True, 'export_morph': False,
        'export_draco_mesh_compression_enable': False,
    }
    # only pass options this Blender version knows (names change between releases)
    properties = bpy.ops.export_scene.gltf.get_rna_type().properties
    kwargs = {}
    for key, value in wanted.items():
        if key not in properties:
            continue
        prop = properties[key]
        if prop.type == 'ENUM' and value not in {item.identifier for item in prop.enum_items}:
            continue
        kwargs[key] = value
    skipped = sorted(set(wanted) - set(kwargs))
    if skipped:
        log('export options not available here:', ', '.join(skipped))
    bpy.ops.export_scene.gltf(**kwargs)
    log('exported', path)


def check_glb(path):
    """Read the GLB JSON chunk and print the acceptance checks."""
    with open(path, 'rb') as file:
        data = file.read()
    length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    accessors = gltf.get('accessors', [])

    triangles = 0
    for mesh in gltf.get('meshes', []):
        for primitive in mesh['primitives']:
            if 'indices' in primitive:
                triangles += accessors[primitive['indices']]['count'] // 3
            else:
                triangles += accessors[primitive['attributes']['POSITION']]['count'] // 3
    skins = gltf.get('skins', [])
    joints = max((len(s['joints']) for s in skins), default=0)
    clips = {}
    for animation in gltf.get('animations', []):
        duration = max(accessors[s['input']]['max'][0] for s in animation['samplers'])
        clips[animation.get('name', '?')] = round(duration, 3)
    has_colors = any('COLOR_0' in p['attributes'] for m in gltf.get('meshes', []) for p in m['primitives'])
    required = gltf.get('extensionsRequired', [])

    checks = [
        ('file size <= 250 KB', len(data) <= MAX_BYTES, f'{len(data) / 1024:.0f} KB'),
        (f'triangles <= {SETTINGS["target_tris"]}', triangles <= SETTINGS['target_tris'], triangles),
        ('exactly 1 skin', len(skins) == 1, len(skins)),
        (f'joints <= {MAX_BONES}', 0 < joints <= MAX_BONES, joints),
        ("clips == ['idle']", list(clips) == ['idle'], clips),
        ('vertex colours (COLOR_0)', has_colors, has_colors),
        ('no required extension', not required, required),
    ]
    log('--- acceptance checks ---')
    for label, ok, value in checks:
        log(('PASS ' if ok else 'FAIL ') + label + f'  ({value})')
    return all(ok for _, ok, _ in checks)


def main():
    parse_cli()
    species = SPECIES[SETTINGS['species']]
    obj = bpy.context.active_object
    if obj is None or obj.type != 'MESH':
        raise SystemExit('Select the whale mesh (make it the active object) first.')
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')

    normalise(obj)
    decimate(obj, SETTINGS['target_tris'])
    rig = build_armature(obj, species)
    skin(obj, rig)
    travel = make_idle(rig)
    low, high = FLUKE_PEAK_TO_PEAK
    log(f'fluke tip travel over the loop: {travel:.3f} body lengths '
        f'({"PASS" if low <= travel <= high else "adjust IDLE_AMPLITUDES"}, target {low}-{high})')
    paint(obj, rig, species)

    path = bpy.path.abspath(SETTINGS['out'])
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    export(obj, rig, path)
    ok = check_glb(path)
    log('DONE' if ok else 'DONE with failures (see above)')


main()
