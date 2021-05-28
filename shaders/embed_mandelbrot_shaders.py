#!/usr/bin/env python3

import sys
import os
import subprocess

if len(sys.argv) < 2:
    print("Usage <glslc>")

glslc = sys.argv[1]
shaders = ["mandelbrot.comp", "mandelbrot.frag", "mandelbrot.vert"]
output = "embedded_mandelbrot_shaders.js"

try:
    os.stat(output)
    os.remove(output)
except:
    pass

compiled_shaders = ""
for shader in shaders:
    fname, ext = os.path.splitext(os.path.basename(shader))
    var_name ="{}_{}_spv".format(fname, ext[1:])
    print("Embedding {} as {}".format(shader, var_name))
    args = ["python", "compile_shader.py", glslc, shader, var_name, "-O"]
    compiled_shaders += subprocess.check_output(args).decode("utf-8")

with open(output, "w") as f:
    f.write(compiled_shaders)

