#!/usr/bin/env python3

import sys
import os
import subprocess

if len(sys.argv) < 2:
    print("Usage <glslc> <shaders...>")

glslc = sys.argv[1]
output = "zfp_decompress_spv.js"
shaders = ["zfp_decompress_block.comp"]

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
    # Note: building with -O leads to a miscompile of the decompression shader
    args = ["python", "compile_shader.py", glslc, shader, var_name]
    compiled_shaders += subprocess.check_output(args).decode("utf-8")

with open(output, "w") as f:
    f.write(compiled_shaders)

