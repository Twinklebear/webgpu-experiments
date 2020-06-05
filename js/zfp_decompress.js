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

    var compressionRate = 4;
    var baseVolumeName = "magnetic_reconnection_512x512x512_float32.raw";
    //var baseVolumeName = "skull_256x256x256_uint8.raw";
    //var baseVolumeName = "fuel_64x64x64_uint8.raw";
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

    var decompressor = new ZFPDecompressor(device);
    var decompressed = await decompressor.decompress(compressedData, compressionRate, volumeDims);

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


