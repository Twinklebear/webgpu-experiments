var lasFile = null;
var newLasFile = null;
var newLasFileReady = false;

function uploadLAS(file) {
    var reader = new FileReader();
    reader.onerror = function() {
        alert("error reading las/laz");
    }
    reader.onload = function(evt) {
        newLasFile = new LASFile(reader.result, file[0].name);
        console.log(`Opened LAS/LAZ file '${file[0].name}' containing ${newLasFile.numPoints} points`);
        console.log(`Bounds = ${newLasFile.bounds}`);

        newLasFile.loadPoints();
        console.log(`Loaded ${newLasFile.numLoadedPoints} (noise discarded)`);
        newLasFileReady = true;
    }
    reader.readAsArrayBuffer(file[0]);
}

