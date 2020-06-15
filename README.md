# WebGPU Experiments

## Triangle & Generated Triangle

Basic demos of rendering a triangle, or generating one and the draw calls in a compute shader.

![triangle image](https://i.imgur.com/qmiPZx8.png)

## GLB Viewer [Try it out!](https://www.willusher.io/webgpu-experiments/glb_viewer.html)

A binary glTF viewer supporting static scenes with multi-level instancing, different materials, and textures.

![sponza](https://i.imgur.com/GQBJC92.png)

## Marching Cubes [Try it out!](https://www.willusher.io/webgpu-experiments/marching_cubes.html)

A data-parallel implementation of Marching Cubes using compute shaders.
Note that as of 5/7/2020 some functionality (3D texture uploads) is not implemented in WebGPU
which would make this easier to implement or include some other features (e.g.,
sampling the volume, adding volume rendering),

![isosurface on the Skull data set](https://i.imgur.com/3XMumHL.png)

## LiDAR Viewer [Try it out!](https://www.willusher.io/webgpu-experiments/lidar_viewer.html)

A viewer for las/laz files. Uses [LASTools.js](https://github.com/Twinklebear/LAStools.js)
to load las/laz files directly in the browser, and renders them as instanced billboard quads.
To run this demo, download the LASTools.js release (liblas.js, liblas.wasm, liblas_wrapper.js)
and place them under `js/`.

![Morro Rock](https://i.imgur.com/j21k9Z9.png)

