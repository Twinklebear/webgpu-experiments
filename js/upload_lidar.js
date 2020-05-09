var lasFile = null;
var newLasFile = false;

function uploadLAS(file) {
    var reader = new FileReader();
    reader.onerror = function() {
        alert("error reading las/laz");
    }
    reader.onload = function(evt) {
        lasFile = new LASFile(reader.result, file[0].name);
        console.log(`Opened LAS/LAZ file '${file[0].name}' containing ${lasFile.numPoints} points`);
        console.log(`Bounds = ${lasFile.bounds}`);

        lasFile.loadPoints();
        console.log(`Loaded ${lasFile.numLoadedPoints} (noise discarded)`);
        newLasFile = true;
    }
    reader.readAsArrayBuffer(file[0]);
}

