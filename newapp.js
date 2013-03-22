var blobloadServer = require('./blobload.js');

require('fs').readFile(__dirname + '/index.html', function (err, data) {
    if (! err) {
        blobloadServer.eventDispatcher.on("WebPageAccessDetected", function(data){
            console.log("web page access. data: " + data);
        });
        blobloadServer.eventDispatcher.on("WebPageAccessDetected", function(data){
            console.log("web page access. data: " + data);
        });
        blobloadServer.setWebPageAccessContent(200, data);
        blobloadServer.create(1337, 0, 0, null, null, null).start();
    }
});