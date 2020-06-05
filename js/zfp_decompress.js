(async () => {
    var fileRegex = /(\w+)_(\d+)x(\d+)x(\d+)_(\w+)\.*/;

    var getVolumeDimensions = function(name) {
        var m = name.match(fileRegex);
        return [parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
    }

    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("gpupresent");
    var swapChainFormat = "bgra8unorm";
    var swapChain = context.configureSwapChain({
        device: device,
        format: swapChainFormat,
        usage: GPUTextureUsage.OUTPUT_ATTACHMENT
    });

    //var baseVolumeName = "skull_256x256x256_uint8.raw";
    var baseVolumeName = "fuel_64x64x64_uint8.raw";
    var volumeDims = getVolumeDimensions(baseVolumeName);
    var zfpDataName = baseVolumeName + ".zfp";
    var expectDataName = baseVolumeName + ".expect_decomp";
    var compressedData = await fetch("/models/" + zfpDataName)
        .then(res => res.arrayBuffer().then(function (arr) { 
            return new Uint8Array(arr);
        }));
    console.log(compressedData);
    var expectedData = await fetch("/models/" + expectDataName)
        .then(res => res.arrayBuffer().then(function (arr) { 
            return new Float32Array(arr);
        }));

    if (compressedData == null || expectedData == null) {
        alert(`Failed to load compressed data or expected data`);
        return;
    }

    var maxBits = 4;
    var decompressor = new ZFPDecompressor(device);
    var start = performance.now();
    var decompressed = await decompressor.decompress(compressedData, maxBits, volumeDims);
    var end = performance.now();
    console.log(`Decompressed ${decompressed.byteLength} in ${end - start}ms = ${0.001 * decompressed.byteLength / (end - start)} MB/s`);

    // Verify we decompressed the data correctly
    var matched = true;
    for (var i = 0; i < decompressed.length && matched; ++i) {
        if (decompressed[i] != expectedData[i]) {
            console.log(`Results do not match expected! At ${i} got ${decompressed[i]} but expected ${expectedData[i]}`);
            matched = false;
        }
    }
    if (matched) {
        console.log("Results match");
    }
})();


