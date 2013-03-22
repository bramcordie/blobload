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
 * The web page access status code.
 * @type {string}
 */
var webPageAccessStatus = "501";

/**
 * The web page access body content.
 * @type {string}
 */
var webPageAccessContent = "Error: the blobload server hasn't been started yet";

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
var totalBufferSize = 0;

/**
 * Get the web page access status code.
 * @returns {string}
 */
function getWebPageAccessStatus(){
    return webPageAccessStatus;
}

/**
 * Get the web page access body content.
 * @returns {string}
 */
function getWebPageAccessContent(){
    return webPageAccessContent;
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
            byteBuffer: ''       // initialization of the byte buffer is necessary
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

/**
 * TODO: doc
 * @param data
 * @param socket
 */
function processSlice(data, socket){
    var file = Files[data['token']];

    if(! file){
        socket.emit('EncounteredError', {'error': 'File not found', 'data': data});
        return;
    }

    if(data.sliceNumber == null){
        socket.emit('EncounteredError', {'error': 'No sliceNumber received', 'data': data});
        return;
    }

    if(data.sliceNumber != file.bytePointer){
        socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : sliceSize});
        return;
    }

    file.byteBuffer += data['slice'];
    file.bytePointer += sliceSize;
    totalBufferSize += sliceSize;

    // if upload is completed...
    if(file.bytePointer >= file.size) {
        fs.write(file.handler, file.byteBuffer, null, 'Binary', function(err, written, buffer){
            if(err){
                socket.emit('EncounteredError', {'error': 'An error occurred while finalizing the uploaded file', 'data': data});
                return;
            }
            var finalFilePath = storageFolderPath + file.token + '.' + file.type;
            var inp = fs.createReadStream(tempFolderPath + file.token + '.' + file.type);
            var out = fs.createWriteStream(finalFilePath);
            inp.pipe(out, {});
            out.end = function(){
                fs.unlink(tempFolderPath + file.token + '.' + file.type, function () {
                    // you can hook up other services here
                    socket.emit('FileCompleted', {'token' : file.token});
                    eventDispatcher.emit('NewFileCompletelyUploaded', {"path": finalFilePath, "checksum" : file.checksum, "size"	 : file['size'], "type" : file.type});
                })};
        });
    }
    // if buffer should be flushed...
    else if(file.byteBuffer.length > dataBufferLimit){
        fs.write(file.handler, file.byteBuffer, null, 'Binary', function(err, written, buffer){
            if(err){
                socket.emit('EncounteredError', {'error': 'An error occurred while flushing the buffer', 'data': data});
                return;
            }
            // TODO: if statement for error
            file.byteBuffer = "";
            socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : sliceSize});
        });

    }
    else {
        socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : sliceSize});
    }
}

/**
 * Create a blobload server.
 * @param port The port this blobload instance is to start running on.
 * @param sliceSizeToSet
 * @param dataBufferLimitToSet
 * @param tempFolderNameToSet
 * @param storageFolderNameToSet
 * @param tokenValidator
 *
 * TODO: doc
 */
exports.create = function (port, sliceSizeToSet, dataBufferLimitToSet, tempFolderNameToSet, storageFolderNameToSet, tokenValidator){

    sliceSize = sliceSizeToSet > 0 ? sliceSizeToSet : 524288;
    dataBufferLimit = dataBufferLimitToSet > sliceSize ? dataBufferLimitToSet : 10485760; //10MB
    storageFolderPath = storageFolderNameToSet ? ((storageFolderNameToSet.charAt(storageFolderNameToSet.length -1) == '/') ? storageFolderNameToSet : (storageFolderNameToSet + '/')) :  "completed/";
    tempFolderPath = tempFolderNameToSet ? (tempFolderNameToSet.charAt(tempFolderNameToSet.length -1) == '/') ? tempFolderNameToSet : (tempFolderNameToSet + '/') : "temp/";

    this.setWebPageAccessContent(505, "This ain't no web server");

    // create an all purpose validator if none is provided
    if(! tokenValidator){
        tokenValidator = function(token, checksum, callback){
            callback(true);
        }
    }

    httpServer = http.createServer(function (req, res) {
        eventDispatcher.emit("WebPageAccessDetected");
        res.writeHead(getWebPageAccessStatus());
        return res.end(getWebPageAccessContent());
    });

    var ioSockets = io.listen(httpServer).sockets;

    ioSockets.on('connection', function (socket) {
        socket.on('NewFile', function (data) {
            if(Files[data['token']] && Files[data['token']].tokenVerified){
                processNewUpload(socket, data);
            }
            else{
                tokenValidator(
                    data['token'],
                    data['checksum'],
                    function(isValidToken, err){
                        isValidToken ? processNewUpload(socket, data) : socket.emit('EncounteredError', {'error': err, 'result': 'Token validation failed', 'data': data});
                    }
                );
            }
        });

        socket.on('SendSlice', function (data){
            processSlice(data, socket);
        });
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

exports.setWebPageAccessContent = function(status, content){
    webPageAccessStatus = status;
    webPageAccessContent = content;
    return this;
}

exports.setPort = function(newPort){
    port = newPort;
    return this;
}

exports.eventDispatcher = eventDispatcher;