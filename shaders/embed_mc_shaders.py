#!/usr/bin/env python3

import sys
import os
import subprocess

if len(sys.argv) < 2:
    print("Usage <glslc> <shaders...>")

glslc = sys.argv[1]
shaders = ["prefix_sum.comp", "block_prefix_sum.comp", "add_block_sums.comp"]

try:
    os.stat("embed_marching_cubes_shaders.js")
    os.remove("embed_marching_cubes_shaders.js")
except:
    pass

block_size = 256

compiled_shaders = ""
for shader in shaders:
    print(shader)
    fname, ext = os.path.splitext(os.path.basename(shader))
    var_name ="{}_{}_spv".format(fname, ext[1:])
    print("Embedding {} as {}".format(shader, var_name))
    args = ["python3", "compile_shader.py", glslc, shader, var_name, "-DBLOCK_SIZE={}".format(block_size),
            "-O"]
    compiled_shaders += subprocess.check_output(args).decode("utf-8")

with open("embed_marching_cubes_shaders.js", "w") as f:
    f.write("const ScanBlockSize = {};\n".format(block_size))
    f.write(compiled_shaders)


