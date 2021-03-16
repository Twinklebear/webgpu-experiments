#!/usr/bin/env python3

import sys
import os
import subprocess

if len(sys.argv) < 2:
    print("Usage <glslc> <shaders...>")

glslc = sys.argv[1]
output = "glb_shaders.js"
shaders = ["glb.vert", "glb.frag"]
variants = {
    "pos": [],
    "posnormal": ["-DNORMAL_ATTRIB=1"],
    "posnormaluv": ["-DNORMAL_ATTRIB=1", "-DUV_ATTRIB=1"],
    "posuv": ["-DUV_ATTRIB=1"],
    "pnutex": ["-DNORMAL_ATTRIB=1", "-DUV_ATTRIB=1", "-DBASE_COLOR_TEXTURE=1"],
}

try:
    os.stat(output)
    os.remove(output)
except:
    pass

compiled_shaders = ""
for variant_name, defines in variants.items():
    print(variant_name)
    print(defines)

    for shader in shaders:
        print(shader)
        fname, ext = os.path.splitext(os.path.basename(shader))
        var_name ="{}_{}_{}_spv".format(fname, variant_name, ext[1:])
        print("Embedding {} as {}".format(shader, var_name))
        # -O seems to be hitting a miscompile right now in the srgb fragment shader
        # code on DX12 backends
        args = ["python", "compile_shader.py", glslc, shader, var_name]
        args.extend(defines)
        compiled_shaders += subprocess.check_output(args).decode("utf-8")

with open(output, "w") as f:
    f.write(compiled_shaders)


