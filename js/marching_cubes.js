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
    //for (var i = 0; i < scanner.maxScanSize * 4; ++i) {
    for (var i = 0; i < scanner.maxScanSize * 4; ++i) {
        //array.push(Math.floor(Math.random() * 100 - 50));
        array.push(1);
    }
    var serialOut = serialExclusiveScan(array);

    var serialSum = 0;
    for (var i = 0; i < array.length; ++i) {
        serialSum = Math.fround(serialSum + array[i]);
    }

    var sum = await exclusive_scan(scanner, array);
    console.log(`parallel sum ${sum}`);
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
                //console.log(`Differing elements at ${i}: parallel got ${array[i]}, expected ${serialOut[i]}`);
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


