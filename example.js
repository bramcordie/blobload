//
// Example usage for the blobload module.
// --------------------------------------

// require the blobload module...
var blobloadServer = require('./blobload.js');

// In this example we're going to read out the content of an HTML file to use as the content shown when a client visits
// the blobload service through plain old HTTP (e.g. with a web browser).
//
// So we first read the content of the HTML file, then when the content has been read successfully, we setup the read
// content as the HTTP access content of the blobload server and then start it.
require('fs').readFile(__dirname + '/index.html', function (err, data) {
    if (! err) {

        // We will subscribe to the serverStarted event of the blobload server to log a message to the console
        // whenever the server is started.
        blobloadServer.eventDispatcher.on("serverStarted", function(){
            console.log("Server started");
        });

        // test section -------------
        //
        //
        blobloadServer.eventDispatcher.on("bufferCleanUpStarted", function(){
            console.log("buffer cleanup started");
        });

        blobloadServer.eventDispatcher.on("bufferCleanUpFinished", function(){
            console.log("buffer cleanup finished");
        });

        blobloadServer.eventDispatcher.on("foundExpiredUpload", function(file){
            console.log(file);
        });
        //
        //
        // end test section ---------

        blobloadServer.setup(1337, 0, 0, 1, 10, null, null, null);
        blobloadServer.setHttpAccessContent(200, data);
        blobloadServer.start();
    }
});