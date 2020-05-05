(async () => {
    var serialExclusiveScan = function(array) {
        var output = Array.from(array);
        output[0] = 0;
        for (var i = 1; i < array.length; ++i) {
            output[i] = array[i - 1] + output[i - 1];
        }
        return output;
    }

    var workGroupSize = 4;
    var workGroupElements = workGroupSize * 2;
    var array = [];
    for (var i = 0; i < workGroupElements * 4; ++i) {
        array.push(i);
    }
    console.log(array);
    var serialOut = serialExclusiveScan(array);
    console.log("serial scan");
    console.log(serialOut);

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

    // Input buffer
    var [dataBuf, mapping] = device.createBufferMapped({
        size: array.length * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    new Float32Array(mapping).set(array);
    dataBuf.unmap();

    // Block sum buffer, padded up to workGroupElements size
    var nblockSums = Math.max(array.length / workGroupElements, workGroupElements);
    console.log(`num block sums ${nblockSums}`);
    var [blockSumBuf, mapping] = device.createBufferMapped({
        size: nblockSums * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    new Float32Array(mapping).fill(0);
    console.log(new Float32Array(mapping));
    blockSumBuf.unmap();

    // TODO: Need way to not pass block sum buffer as well, to have scan
    // skip writing it out or requiring it in the pipeline
    var scratchBuf = device.createBuffer({
        size: nblockSums * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    var computeBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            }
        ]
    });

    var scanInputBindGroup = device.createBindGroup({
        layout: computeBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: dataBuf
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: blockSumBuf
                }
            }
        ]
    });
    var scanBlockBindGroup = device.createBindGroup({
        layout: computeBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: blockSumBuf
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: scratchBuf
                }
            }
        ]
    });

    var computeLayout = device.createPipelineLayout({bindGroupLayouts: [computeBindGroupLayout]});

    var scanPipeline = device.createComputePipeline({
        layout: computeLayout,
        computeStage: {
            module: device.createShaderModule({code: prefix_sum_comp_spv}),
            entryPoint: "main"
        }
    });

    var addBlockSumsPipeline = device.createComputePipeline({
        layout: computeLayout,
        computeStage: {
            module: device.createShaderModule({code: add_block_sums_comp_spv}),
            entryPoint: "main"
        }
    });

    var readbackBuf = device.createBuffer({
        size: array.length * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    var readbackBlockSums = device.createBuffer({
        size: nblockSums * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var commandEncoder = device.createCommandEncoder();

    var computePass = commandEncoder.beginComputePass();

    computePass.setPipeline(scanPipeline);
    computePass.setBindGroup(0, scanInputBindGroup);
    console.log(`num work groups ${array.length / workGroupElements}`);
    computePass.dispatch(array.length / workGroupElements, 1, 1);

    // TODO: We need to repeat this step up process if the number of block sums exceed
    // the number of groups * group size elements we can process at once
    // What would be best to do here is to carry over the results from the previous chunk
    // Then we just go in a loop processing the max # of elements we can, and applying
    // the additional offset from the previously computed results. This is a bit
    // easier to implement than implementing some scan tree over the blocks and doing
    // some scans on the block chunks
    computePass.setBindGroup(0, scanBlockBindGroup);
    computePass.dispatch(1, 1, 1);
    
    computePass.setPipeline(addBlockSumsPipeline);
    computePass.setBindGroup(0, scanInputBindGroup);
    computePass.dispatch(array.length / workGroupElements, 1, 1);

    computePass.endPass();

    commandEncoder.copyBufferToBuffer(dataBuf, 0, readbackBuf, 0, array.length * 4);
    commandEncoder.copyBufferToBuffer(blockSumBuf, 0, readbackBlockSums, 0, nblockSums * 4);

    device.defaultQueue.submit([commandEncoder.finish()]);

    // Note: no fences on FF nightly at the moment
    var fence = device.defaultQueue.createFence();
    device.defaultQueue.signal(fence, 1);

    await fence.onCompletion(1);

    var mapping = new Float32Array(await readbackBuf.mapReadAsync());
    console.log(mapping);
    var equivalent = serialOut.every(function(v, i) { return v == mapping[i]; });
    if (!equivalent) {
        console.log("compute parallel does not match serial");
    } else {
        console.log("Compute parallel result matches");
    }
    readbackBuf.unmap();

    var mapping = new Float32Array(await readbackBlockSums.mapReadAsync());
    console.log("block sums:");
    console.log(mapping);
})();


