// TODO: cache clearing

/**
 * Module dependencies.
 */
var EventEmitter = require('events').EventEmitter
    , util = require('util')
    , http = require('http')
    , io = require('socket.io')
    , fs = require('fs')
    , util = require('util');

/**
 * The event emitter instance to export the events of a blobload instance.
 * @type {EventEmitter}
 */
var eventDispatcher = new EventEmitter();

/**
 * The array used to store data about the files being uploaded.
 * @type {Object}
 */
var Files = {};

/**
 * The HTTP access status code.
 * @type {number}
 */
var httpAccessStatusCode = 501;

/**
 * The HTTP access content.
 * @type {string}
 */
var httpAccessContent = "Error: the blobload server hasn't been started yet";

/**
 * The port this blobload instance is currently set to be running on.
 * @type {number}
 */
var port = 1337;

/**
 * The slice size (in bytes).
 * @type {number}
 */
var sliceSize;

/**
 * The limit of the buffer used to store slices before flushing (in bytes).
 * @type {number}
 */
var dataBufferLimit;

/**
 * The (relative or absolute) path of the directory where temporary files are stored for currently uploading files.
 * @type {string}
 */
var tempFolderPath;

/**
 * The (relative or absolute) path of the directory where completely uploaded files are stored.
 * @type {string}
 */
var storageFolderPath;

/**
 * TODO: doc
 */
var httpServer;

/**
 * The current total buffer size.
 * @type {number}
 */
var currentTotalBufferSize = 0;

/**
 * The maximum number of connections allowed.
 * @type {number}
 */
var maxConnectionsAllowed;

/**
 * The current number of connected clients.
 * @type {number}
 */
var currentNbOfConnections = 0;

/**
 * Get the HTTP access status code.
 * @returns {number}
 */
function getHttpAccessStatusCode(){
    return httpAccessStatusCode;
}

/**
 * Get the HTTP access content.
 * @returns {string}
 */
function getHttpAccessContent(){
    return httpAccessContent;
}

/**
 * Process an upload (after possible token validation).
 * @param socket
 * TODO: complete doc
 */
function processNewUpload(socket, data){
    // look up file, if it doesn't exist, create it
    var file = Files[data['token']];

    if(file === undefined){
        file = Files[data['token']] = {
            token : data['token'],
            tokenVerified : true, // redundantly stored here to avoid reverification of the token upon future requests
            checksum : data['checksum'],
            size	 : data['size'],
            bytePointer : 0,
            type : data['type'],
            byteBuffer: '',       // initialization of the byte buffer is necessary
            lastUpdated: Date.now()
        }
    }

    try{
        var Stat = fs.statSync(tempFolderPath + file.token + '.' + file.type);
        if(Stat.isFile()){
            file.bytePointer = Stat.size;
        }
    }
    catch(er){
        // it's a new file
    }

    fs.open(tempFolderPath + file.token + '.' + file.type, 'a', 0755, function(err, fd){
        if(err){
            console.log(err);
        }
        else{
            file.handler = fd; // We store the file handler so we can write to it later
            socket.emit('WantSlice', { 'token' : file.token, 'pointer': file.bytePointer, 'size' : sliceSize});
        }
    });
}

var cleanupActive = false;

var bufferBackupTimeInSeconds;

function cleanUp(){
    if(cleanupActive){
        return;
    }

    cleanupActive = true;

    eventDispatcher.emit('bufferCleanUpStarted');

    for(var file in Files){
        var expiryDate = new Date(file.lastUpdated).setSeconds(file.lastUpdated.getSeconds() + bufferBackupTimeInSeconds);
        if(Date.now() > expiryDate){
            eventDispatcher.emit('foundExpiredUpload', {'file' : file});
            delete file; // TODO: check if ok or should be replaced with delete by token
            //TODO: try deleting temp file
        }
    }

    eventDispatcher.emit('bufferCleanUpFinished');

    cleanupActive = false;
}

/**
 * TODO: doc
 */
function processSlice(socket, data){
    console.log('************************');
    console.log('************************');
    console.log(data);
    console.log('************************');
    console.log('************************');
    var file = Files[data['token']];
    if(! file){
        socket.emit('encounteredError', {'error': 'File not found', 'data': data});
        return;
    }

    if(data.bytePointer == null){
        socket.emit('encounteredError', {'error': 'No pointer received', 'data': data});
        return;
    }

    if(data.bytePointer != file.bytePointer){
        socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : sliceSize});
        return;
    }

    if(data.checksum != Files[data['token']].checksum){
        socket.emit('encounteredError', {'error': 'Invalid checksum', 'data': data});
        return;
    }

    file.byteBuffer += data['slice'];
    file.lastUpdated = Date.now();
    file.bytePointer += sliceSize;
    currentTotalBufferSize += sliceSize;

    // if the buffer should be flushed...
    if(file.byteBuffer.length > dataBufferLimit || file.bytePointer >= file.size){
        fs.write(file.handler, file.byteBuffer, null, 'Binary', function(err, written, buffer){
            if(err){
                socket.emit('encounteredError', {'error': 'An error occurred while flushing the buffer', 'data': data});
                return;
            }
            var bufferSize = file.byteBuffer.length;
            file.byteBuffer = "";
            currentTotalBufferSize -= bufferSize;

            // if upload is completed...
            if(file.bytePointer >= file.size) {
                var finalFilePath = storageFolderPath + file.token + '.' + file.type;
                var inp = fs.createReadStream(tempFolderPath + file.token + '.' + file.type);
                var out = fs.createWriteStream(finalFilePath);
                inp.pipe(out, {});
                out.end = function(){
                    delete Files[file.token];
                    fs.unlink(tempFolderPath + file.token + '.' + file.type, function () {
                        socket.emit('fileCompleted', {'token' : file.token});
                        eventDispatcher.emit('newFileCompletelyUploaded', {"path": finalFilePath, "checksum" : file.checksum, "size"	 : file['size'], "type" : file.type});
                    });
                };
            }
            else{
                socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : sliceSize});
            }
        });
    }
    else{
        socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : sliceSize});
    }
}

/**
 * Create a blobload server.
 * @param port The port this blobload instance is to start running on.
 * @param ...
 *
 * TODO: doc
 */
exports.setup = function (port, sliceSizeToSet, dataBufferLimitToSet, maxConnectionsToSet, bufferBackupTimeInSecondsToSet, tempFolderNameToSet, storageFolderNameToSet, authorizer){
    sliceSize = sliceSizeToSet > 0 ? sliceSizeToSet : 524288;
    dataBufferLimit = dataBufferLimitToSet > sliceSize ? dataBufferLimitToSet : 10485760; //10MB
    storageFolderPath = storageFolderNameToSet ? ((storageFolderNameToSet.charAt(storageFolderNameToSet.length -1) == '/') ? storageFolderNameToSet : (storageFolderNameToSet + '/')) :  "completed/";
    tempFolderPath = tempFolderNameToSet ? (tempFolderNameToSet.charAt(tempFolderNameToSet.length -1) == '/') ? tempFolderNameToSet : (tempFolderNameToSet + '/') : "temp/";
    maxConnectionsAllowed = maxConnectionsToSet > 0 ? maxConnectionsToSet : 50;
    bufferBackupTimeInSeconds = bufferBackupTimeInSecondsToSet > 0 ? bufferBackupTimeInSecondsToSet : 3600;

    this.setHttpAccessContent(505, "This ain't no web server");

    // create an all purpose authorizer if none is provided
    if(! authorizer){
        authorizer = function(token, callback){
            callback(null, true);
        }
    }

    httpServer = http.createServer(function (req, res) {
        eventDispatcher.emit("webPageAccessDetected");
        res.writeHead(getHttpAccessStatusCode());
        return res.end(getHttpAccessContent());
    });

    var ioServer = io.listen(httpServer);

    ioServer.configure(function (){
        ioServer.set('authorization', function (handshakeData, callback) {
            if(currentNbOfConnections > maxConnectionsAllowed){
                callback('Too many connections', false);
            }

            if(! (handshakeData.query.token) ){
                callback('No authorization data received', false);
            }
            else{
                authorizer(handshakeData.query.token, function(err){
                    if(err){
                        callback('Authorization failed', false);
                    }
                    else{
                        callback(null, true);
                    }
                });
            }
        });
    });

    ioServer.sockets.on('connection', function (socket) {

        socket.on('NewFile', function (data) {
            processNewUpload(socket, data);
        });

        socket.on('SendSlice', function (data){
            processSlice(socket, data);
        });

        socket.on('disconnect', function () {
            currentNbOfConnections--;
        });

        currentNbOfConnections++;
    });

    return this;
};

exports.stop = function(){
    httpServer.close();
    eventDispatcher.emit('serverStopped');
    return this;
}

exports.start = function(){
    httpServer.listen(port);
    eventDispatcher.emit('serverStarted');
    return this;
}

exports.setHttpAccessContent = function(status, content){
    httpAccessStatusCode = status;
    httpAccessContent = content;
    return this;
}

exports.setPort = function(newPort){
    port = newPort;
    return this;
}

exports.eventDispatcher = eventDispatcher;