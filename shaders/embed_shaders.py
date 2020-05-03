#!/usr/bin/env python3

import sys
import os
import subprocess

if len(sys.argv) < 2 or len(sys.argv) < 3:
    print("Usage <glslc> <shaders...>")

glslc = sys.argv[1]

try:
    os.stat("embedded_spv.js")
    os.remove("embedded_spv.js")
except:
    pass

compiled_shaders = ""
for shader in sys.argv[2:]:
    fname, ext = os.path.splitext(os.path.basename(shader))
    var_name ="{}_{}_spv".format(fname, ext[1:])
    print("Embedding {} as {}".format(shader, var_name))
    subprocess.check_output([glslc, shader, "-mfmt=c"])
    with open("a.spv", "r") as f:
        compiled_code = f.read()
        compiled_shaders += "const " + var_name + " = new Uint32Array([" + compiled_code[1:-2] + "]);\n"

os.remove("a.spv")
with open("embedded_spv.js", "w") as f:
    f.write(compiled_shaders)

