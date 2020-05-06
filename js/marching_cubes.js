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

    var array = [];
    //for (var i = 0; i < scanner.maxScanSize + scanner.blockSize * 4.5; ++i) {
    //for (var i = 0; i < scanner.maxScanSize * 8; ++i) {
    var size = 256;
    for (var i = 0; i < size * size * size; ++i) {
        array.push(Math.floor(Math.random() * 100));
        //array.push(1);
    }
    var serialOut = Array.from(array);
    var serialStart = performance.now();
    var serialSum = serialExclusiveScan(array, serialOut);
    var serialEnd = performance.now();
    console.log(`Serial scan took ${serialEnd - serialStart}`);

    var scanner = new ExclusiveScanner(device);
    scanner.prepareInput(array);
    var parallelStart = performance.now();
    var sum = await exclusive_scan(scanner, array);
    var parallelEnd = performance.now();
    console.log(`parallel sum ${sum}, total caller time ${parallelEnd - parallelStart}`);

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
    console.log(mapping);
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


