"""
Build a species with whale_gen.py, run it through whale_pipeline.py (rig,
paint, export the GLB) and render three preview views of the result:
side, top and three-quarter.

    blender --background --python tools/blender/render_views.py -- humpback OUT_DIR [TAG]

Writes OUT_DIR/<species>.glb and OUT_DIR/<species>[_TAG]_{side,top,three_quarter}.jpg
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import whale_gen  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1:]
species = args[0]
out_dir = os.path.abspath(args[1])
tag = ('_' + args[2]) if len(args) > 2 else ''
os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
obj = whale_gen.build_whale(species)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)

pipeline = os.path.join(HERE, 'whale_pipeline.py')
sys.argv = ['blender', '--background', '--python', pipeline, '--',
            '--species', species, '--out', os.path.join(out_dir, species + '.glb'),
            '--head_axis', '+Y']
exec(compile(open(pipeline).read(), pipeline, 'exec'), {'__name__': '__main__'})

# ---------------------------------------------------------------------------
# Preview renders. Cycles on the CPU: this box has no GL context for
# Workbench/EEVEE background renders.
# ---------------------------------------------------------------------------
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 64
scene.cycles.use_denoising = False  # this build has no OpenImageDenoise
scene.render.resolution_x = 720
scene.render.resolution_y = 440
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.quality = 85

world = bpy.data.worlds.new('preview')
world.use_nodes = True
background = world.node_tree.nodes['Background']
background.inputs[0].default_value = (0.02, 0.06, 0.11, 1.0)
background.inputs[1].default_value = 0.9
scene.world = world

whale = bpy.data.objects[species]
material = bpy.data.materials.new('preview')
material.use_nodes = True
nodes = material.node_tree.nodes
bsdf = nodes['Principled BSDF']
attribute = nodes.new('ShaderNodeAttribute')
attribute.attribute_name = whale.data.color_attributes.active_color.name
material.node_tree.links.new(attribute.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = 0.5
whale.data.materials.clear()
whale.data.materials.append(material)

key = bpy.data.objects.new('key', bpy.data.lights.new('key', type='SUN'))
key.data.energy = 3.2
key.rotation_euler = (math.radians(35), math.radians(-20), math.radians(30))
scene.collection.objects.link(key)
fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', type='SUN'))
fill.data.energy = 0.8
fill.rotation_euler = (math.radians(120), 0, math.radians(-140))
scene.collection.objects.link(fill)

camera = bpy.data.objects.new('camera', bpy.data.cameras.new('camera'))
scene.collection.objects.link(camera)
scene.camera = camera
scene.frame_set(1)


def look_at(location, target=(0, 0, 0)):
    camera.location = location
    direction = Vector(target) - Vector(location)
    camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


views = {
    # Left flank, head to the right
    'side': dict(ortho=1.15, location=(2.5, 0, 0), up='Z'),
    # From above, head to the right
    'top': dict(ortho=1.15, location=(0, 0, 2.5), up='Y'),
    # Front-left, a little above
    'three_quarter': dict(lens=50, location=(1.55, 1.25, 0.75)),
}
for name, view in views.items():
    if 'ortho' in view:
        camera.data.type = 'ORTHO'
        camera.data.ortho_scale = view['ortho']
        camera.location = view['location']
        if name == 'side':
            camera.rotation_euler = (math.radians(90), 0, math.radians(90))
        else:
            camera.rotation_euler = (0, 0, math.radians(90))
    else:
        camera.data.type = 'PERSP'
        camera.data.lens = view['lens']
        look_at(view['location'], (0, -0.05, 0))
    scene.render.filepath = os.path.join(out_dir, f'{species}{tag}_{name}.jpg')
    bpy.ops.render.render(write_still=True)
    print('[render_views] wrote', scene.render.filepath)
