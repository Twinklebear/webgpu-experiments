#!/usr/bin/env python3

import sys
import os
import subprocess

if len(sys.argv) < 2:
    print("Usage <glslc> <shaders...>")

glslc = sys.argv[1]
output = "embed_marching_cubes_shaders.js"
shaders = ["prefix_sum.comp", "block_prefix_sum.comp", "add_block_sums.comp",
        "stream_compact.comp", "mc_isosurface.vert", "mc_isosurface.frag"]

# Shaders to compile different variants of
volume_processing_shaders = ["compute_active_voxel.comp", "compute_num_verts.comp", "compute_vertices.comp"]

variants = {
    "uint8": ["-DVOLUME_DTYPE=uint", "-DUINT8_VOLUME=1"],
    "uint16": ["-DVOLUME_DTYPE=uint", "-DUINT16_VOLUME=1"],
    "uint32": ["-DVOLUME_DTYPE=uint"],
    "float": ["-DVOLUME_DTYPE=float"],
}

try:
    os.stat(output)
    os.remove(output)
except:
    pass

block_size = 512

compiled_shaders = ""
for shader in shaders:
    print(shader)
    fname, ext = os.path.splitext(os.path.basename(shader))
    var_name ="{}_{}_spv".format(fname, ext[1:])
    print("Embedding {} as {}".format(shader, var_name))
    args = ["python", "compile_shader.py", glslc, shader, var_name, "-DBLOCK_SIZE={}".format(block_size),
            "-O"]
    compiled_shaders += subprocess.check_output(args).decode("utf-8")

for variant_name, defines in variants.items():
    print(variant_name)
    print(defines)
    for shader in volume_processing_shaders:
        print(shader)
        fname, ext = os.path.splitext(os.path.basename(shader))
        var_name ="{}_{}_{}_spv".format(fname, variant_name, ext[1:])
        print("Embedding {} as {}".format(shader, var_name))
        args = ["python", "compile_shader.py", glslc, shader, var_name, "-DBLOCK_SIZE={}".format(block_size),
                "-O"]
        args.extend(defines)
        compiled_shaders += subprocess.check_output(args).decode("utf-8")

with open(output, "w") as f:
    f.write("const ScanBlockSize = {};\n".format(block_size))
    f.write(compiled_shaders)


