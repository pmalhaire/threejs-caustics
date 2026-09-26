"""Step 0: rig the app's original whale.obj as the 'classic' species.

    blender --background --python tools/blender/run_classic.py
"""
import math
import os
import sys

import bpy

REPO = '/home/claude/threejs-caustics'
# Work files (.blend, preview renders) go here; the GLB goes to assets/.
SCRATCH = os.environ.get('WORK_DIR', '/tmp/baleines_classic')
os.makedirs(SCRATCH, exist_ok=True)
PIPELINE = os.path.join(REPO, 'tools/blender/whale_pipeline.py')
OUT = os.path.join(REPO, 'assets/classic.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)
# Keep the raw OBJ coordinates: the app uses them as-is in a Z-up scene.
bpy.ops.wm.obj_import(filepath=os.path.join(REPO, 'assets/whale.obj'),
                      forward_axis='Y', up_axis='Z')
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print('[classic] imported meshes:', [(o.name, len(o.data.vertices)) for o in meshes])
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
obj.name = 'classic'
# Merge split vertices (OBJ exports often duplicate them per face) so the
# decimation and skin weights behave like on the generated species.
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.01)
bpy.ops.object.mode_set(mode='OBJECT')
print('[classic] after merge:', len(obj.data.vertices), 'verts')

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SCRATCH, 'classic_pre.blend'))

head = os.environ.get('HEAD_AXIS', 'auto')
sys.argv = ['blender', '--background', '--python', PIPELINE, '--',
            '--species', 'classic', '--out', OUT, '--head_axis', head]
source = open(PIPELINE).read()
# This mesh has a longer, thinner tail than the generated species: with the
# shared amplitudes the fluke tip travels 0.081 body lengths (target <= 0.08).
scale = float(os.environ.get('AMP_SCALE', '0.9'))
source = source.replace('\nmain()', f'\nIDLE_AMPLITUDES = {{k: v * {scale} for k, v in IDLE_AMPLITUDES.items()}}\nmain()')
exec(compile(source, PIPELINE, 'exec'), {'__name__': '__main__'})

# Preview renders (Cycles CPU: no GL context on this box)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 32
scene.cycles.use_denoising = False
scene.render.resolution_x = 900
scene.render.resolution_y = 700
world = bpy.data.worlds.new('w')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.03, 0.07, 0.12, 1.0)
world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
scene.world = world

whale = bpy.data.objects['classic']
mat = bpy.data.materials.new('classic_preview')
mat.use_nodes = True
attr = mat.node_tree.nodes.new('ShaderNodeAttribute')
attr.attribute_name = whale.data.color_attributes.active_color.name if whale.data.color_attributes.active_color else 'Col'
mat.node_tree.links.new(attr.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
whale.data.materials.clear()
whale.data.materials.append(mat)

sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', type='SUN'))
sun.data.energy = 3.0
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(55), 0, math.radians(35))
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 1.5
scene.collection.objects.link(cam)
scene.camera = cam
scene.frame_set(1)

cam.location = (0, 0, 2.0)
cam.rotation_euler = (0, 0, 0)
scene.render.filepath = os.path.join(SCRATCH, 'classic_top.png')
bpy.ops.render.render(write_still=True)
cam.location = (2.0, 0, 0)
cam.rotation_euler = (math.radians(90), 0, math.radians(90))
scene.render.filepath = os.path.join(SCRATCH, 'classic_side.png')
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SCRATCH, 'classic_final.blend'))
