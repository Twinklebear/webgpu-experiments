(async () => {
    var reducePhase = function(array) {
        // TODO: handle non pow2 size
        for (var d = 0; d < Math.log2(array.length); ++d) {
            for (var k = 0; k < array.length; k += Math.pow(2, d + 1)) {
                array[k + Math.pow(2, d + 1) - 1] = 
                    array[k + Math.pow(2, d) - 1] +
                    array[k + Math.pow(2, d + 1) - 1];
            }
        }
    }

    var downSweep = function(array) {
        array[array.length - 1] = 0;
        for (var d = Math.log2(array.length) - 1; d >= 0; --d) {
            for (var k = 0; k < array.length; k += Math.pow(2, d + 1)) {
                var tmp = array[k + Math.pow(2, d) - 1];
                array[k + Math.pow(2, d) - 1] = array[k + Math.pow(2, d + 1) - 1];
                array[k + Math.pow(2, d + 1) - 1] = tmp + array[k + Math.pow(2, d + 1) - 1];
            }
        }
    }

    var exclusiveScan = function(array) {
        var output = Array.from(array);
        reducePhase(output);
        console.log("After reduce");
        console.log(output);

        downSweep(output);
        console.log("After down sweep");
        console.log(output);
        return output;
    }

    var serialExclusiveScan = function(array) {
        var output = Array.from(array);
        output[0] = 0;
        for (var i = 1; i < array.length; ++i) {
            output[i] = array[i - 1] + output[i - 1];
        }
        return output;
    }

    var array = [1, 2, 3, 4];
    var out = exclusiveScan(array);
    console.log(out);

    var serialOut = serialExclusiveScan(array);
    console.log("serial scan");
    console.log(serialOut);

    var equivalent = out.every(function(v, i) { return v == serialOut[i]; });
    if (!equivalent) {
        console.log("Parallel does not match serial");
    } else {
        console.log("Results match");
    }

    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("gpupresent");
    var swapChainFormat = "bgra8unorm";
    var swapChain = context.configureSwapChain({
        device,
        format: swapChainFormat,
        usage: GPUTextureUsage.OUTPUT_ATTACHMENT
    });

    var valsPerGroup = 1;
    var groupSize = 1;
    var ngroups = 2;
    var totalVals = valsPerGroup * groupSize * ngroups;

    // Setup compute pass to generate our "vertices"
    var dataBuf = device.createBuffer({
        size: totalVals * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    var computeBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            }
        ]
    });
    var computeBindGroup = device.createBindGroup({
        layout: computeBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: dataBuf
                }
            }
        ]
    });
    var computeLayout = device.createPipelineLayout({bindGroupLayouts: [computeBindGroupLayout]});

    var computePipeline = device.createComputePipeline({
        layout: computeLayout,
        computeStage: {
            module: device.createShaderModule({code: prefix_sum_comp}),
            entryPoint: "main"
        }
    });

    var readbackBuf = device.createBuffer({
        size: totalVals * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var commandEncoder = device.createCommandEncoder();

    console.log(`ngroups ${ngroups}`);

    var computePass = commandEncoder.beginComputePass();
    computePass.setBindGroup(0, computeBindGroup);
    computePass.setPipeline(computePipeline);
    // Note: x, y, z = num work groups, as in OpenGL
    computePass.dispatch(ngroups, 1, 1);
    computePass.endPass();

    commandEncoder.copyBufferToBuffer(dataBuf, 0, readbackBuf, 0, totalVals * 4);

    device.defaultQueue.submit([commandEncoder.finish()]);

    // Note: no fences on FF nightly at the moment
    var fence = device.defaultQueue.createFence();
    device.defaultQueue.signal(fence, 1);

    await fence.onCompletion(1);

    var mapping = await readbackBuf.mapReadAsync();
    console.log(new Float32Array(mapping));
    readbackBuf.unmap();
})();


