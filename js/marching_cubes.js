(async () => {
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

    var scanner = new ExclusiveScanner(device);

    var array = [];
    var size = 128;
    for (var i = 0; i < size * size * size; ++i) {
        array.push(Math.floor(Math.random() * 100));
        //array.push(1);
    }

    var serialOut = Array.from(array);
    var totalSerialTime = 0;
    var numIterations = 100;
    for (var i = 0; i < numIterations; ++i) {
        var serialStart = performance.now();
        var serialSum = serialExclusiveScan(array, serialOut);
        var serialEnd = performance.now();
        totalSerialTime += serialEnd - serialStart;
    }
    console.log(`Avg. serial time ${totalSerialTime / numIterations}`);

    scanner.prepareInput(array);

    var [uploadBuf, mapping] = device.createBufferMapped({
        size: array.length * 4,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE
    });
    new Uint32Array(mapping).set(array);
    uploadBuf.unmap();

    var commandEncoder = device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(uploadBuf, 0, scanner.inputBuf, 0, array.length * 4);
    var setInputCommandBuf = commandEncoder.finish();
    // Run a warm up scan to build the pipeline and setup
    var sum = await exclusive_scan(scanner, array);

    var totalParallelTime = 0;
    for (var i = 0; i < numIterations; ++i) {
        device.defaultQueue.submit([setInputCommandBuf]);

        var parallelStart = performance.now();
        var sum = await exclusive_scan(scanner, array);
        var parallelEnd = performance.now();
        totalParallelTime += parallelEnd - parallelStart;
    }
    console.log(`Avg. parallel time ${totalParallelTime / numIterations}`);

    // Readback the result. Not timed since the future Marching Cubes method will
    // keep this data on the GPU. So this should in the future take a GPU buffer
    var readbackBuf = scanner.device.createBuffer({
        size: array.length * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var commandEncoder = device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(scanner.inputBuf, 0, readbackBuf, 0, array.length * 4);
    device.defaultQueue.submit([commandEncoder.finish()]);

    // Note: no fences on FF nightly at the moment
    //await new Promise(r => setTimeout(r, 2000));
    var fence = device.defaultQueue.createFence();
    device.defaultQueue.signal(fence, 1);
    await fence.onCompletion(1);

    var mapping = new Uint32Array(await readbackBuf.mapReadAsync());
    for (var i = 0; i < array.length; ++i) {
        array[i] = mapping[i];
    }

    console.log(array);

    if (serialSum != sum) {
        console.log("Sums don't match");
        console.log(`parallel sum ${sum}, serial ${serialSum}`);
    } else {
        console.log("Sums match");
    }

    var matches = serialOut.every(function(v, i) { return array[i] == v; });
    if (!matches) {
        console.log("Parallel result does not match serial");
        for (var i = 0; i < array.length; ++i) {
            if (Math.abs(array[i] - serialOut[i]) > 0.01) {
                console.log(`First differing elements at ${i}: parallel got ${array[i]}, expected ${serialOut[i]}`);
                break;
            }
        }
        console.log("parallel result");
        console.log(array);
        console.log("serial result");
        console.log(serialOut);
    } else {
        console.log("Results match");
    }
})();


