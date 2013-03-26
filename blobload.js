// TODO: test resume upload when after stopping when buffer has not yet been flushed. I think since the bytepointer is set to the size of the temp file, new slices are appended to the unempty buffer upon resume. Set buffer size large and stop upload to test.

/**
 * Module dependencies.
 */
EventEmitter = require('events').EventEmitter
    , util = require('util')
    , http = require('http')
    , io = require('socket.io')
    , fs = require('fs')
    , util = require('util');

/**
 * The event emitter instance to export the events of a blobload server instance.
 * @type {EventEmitter}
 */
var eventDispatcher = new EventEmitter();

/**
 * The blobload server object.
 * @type {{buffer: {}, httpAccessStatusCode: number, httpAccessContent: string, port: number, sliceSize: number, dataBufferLimit: number, tempFolderPath: string, storageFolderPath: string, httpServer: null, currentTotalBufferSize: number, maxConnectionsAllowed: number, currentNbOfConnections: number, bufferBackupTimeInSeconds: number, getHttpAccessStatusCode: Function, getHttpAccessContent: Function, processNewUpload: Function, processSlice: Function, setup: Function, stop: Function, start: Function, getFileLocation: Function, setHttpAccessData: Function, setPort: Function}}
 */
var BlobloadServer = {
    
    /**
     * The object used to store data about the files being uploaded.
     * @type {Object}
     */
    buffer : {},
    
    /**
     * The HTTP access status code.
     * @type {number}
     */
    httpAccessStatusCode : 501,
    
    /**
     * The HTTP access content.
     * @type {string}
     */
    httpAccessContent : "Error: the blobload server hasn't been started yet",
    
    /**
     * The port this blobload instance is currently set to be running on.
     * @type {number}
     */
    port : 1337,
    
    /**
     * The slice size (in bytes).
     * @type {number}
     */
    sliceSize : 524288,
    
    /**
     * The limit of the buffer used to store slices before flushing (in bytes).
     * @type {number}
     */
    dataBufferLimit : 10485760,
    
    /**
     * The (relative or absolute) path of the directory where temporary files are stored for currently uploading files.
     * @type {string}
     */
    tempFolderPath : "temp/",
    
    /**
     * The (relative or absolute) path of the directory where completely uploaded files are stored.
     * @type {string}
     */
    storageFolderPath : "completed/",
    
    /**
     * The HTTP server instance.
     */
    httpServer : null,
    
    /**
     * The current total buffer size.
     * @type {number}
     *
     * TODO: evaluate the need for cache cleaning when buffer size is almost at its limits. Disabling this functionality for now.
     */
    currentTotalBufferSize : 0,
    
    /**
     * The maximum number of connections allowed.
     * @type {number}
     */
    maxConnectionsAllowed : 100,
    
    /**
     * The current number of connected clients.
     * @type {number}
     */
    currentNbOfConnections : 0,

    /**
     * The amount of time to keep uploaded data in the buffer before cleanup after the client disconnects before the upload is finished (in seconds).
     */
    bufferBackupTimeInSeconds : 3600,
    
    /**
     * Get the HTTP access status code.
     * @returns {number}
     */
    getHttpAccessStatusCode : function (){
        return this.httpAccessStatusCode;
    },
    
    /**
     * Get the HTTP access content.
     * @returns {string}
     */
    getHttpAccessContent : function(){
        return this.httpAccessContent;
    },
    
    /**
     * Process a new upload.
     * @param socket The socket the client is connected to.
     * @param data The data passed on by the client through the socket.
     */
    processNewUpload : function(socket, data){
        // look up file, if it doesn't exist, create it
        var file = this.buffer[data['token']];
    
        if(file === undefined){
            file = this.buffer[data['token']] = {
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
            var Stat = fs.statSync(this.tempFolderPath + file.token + '.' + file.type);
            if(Stat.isFile()){
                file.bytePointer = Stat.size;
            }
        }
        catch(er){
            // it's a new file
        }

        var _this = this;
        fs.open(this.tempFolderPath + file.token + '.' + file.type, 'a', 0755, function(err, fd){
            if(err){
                console.log(err);
            }
            else{
                file.handler = fd; // We store the file handler so we can write to it later
                socket.emit('WantSlice', { 'token' : file.token, 'pointer': file.bytePointer, 'size' : _this.sliceSize});
            }
        });
    },

    /**
     * Process a slice upload.
     * @param socket The socket the client is connected to.
     * @param data The data passed on by the client through the socket.
     */
    processSlice : function(socket, data){
        var file = this.buffer[data['token']];
        if(! file){
            socket.emit('encounteredError', {'error': 'File not found', 'data': data});
            return;
        }
    
        if(data.bytePointer == null){
            socket.emit('encounteredError', {'error': 'No pointer received', 'data': data});
            return;
        }
    
        if(data.bytePointer != file.bytePointer){
            socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : this.sliceSize});
            return;
        }
    
        if(data.checksum != this.buffer[data['token']].checksum){
            socket.emit('encounteredError', {'error': 'Invalid checksum', 'data': data});
            return;
        }
    
        file.byteBuffer += data['slice'];
        file.lastUpdated = Date.now();
        file.bytePointer += data['slice'].length;

        // TODO: re-enable when necessary
        //this.currentTotalBufferSize += data['slice'].length;
    
        // if the buffer should be flushed...
        if(file.byteBuffer.length > this.dataBufferLimit || file.bytePointer >= file.size){
            var _this = this;
            fs.write(file.handler, file.byteBuffer, null, 'Binary', function(err, written, buffer){
                if(err){
                    socket.emit('encounteredError', {'error': 'An error occurred while flushing the buffer', 'data': data});
                    return;
                }
                var bufferSize = file.byteBuffer.length;
                file.byteBuffer = "";

                // TODO: re-enable when necessary
                _this.currentTotalBufferSize -= bufferSize;
    
                // if upload is completed...
                if(file.bytePointer >= file.size) {
                    var finalFilePath = _this.storageFolderPath + file.token + '.' + file.type;
                    var inp = fs.createReadStream(_this.tempFolderPath + file.token + '.' + file.type);
                    var out = fs.createWriteStream(finalFilePath);
                    inp.pipe(out, {});
                    out.end = function(){
                        delete _this.buffer[file.token];
                        fs.unlink(_this.tempFolderPath + file.token + '.' + file.type, function () {
                            socket.emit('fileCompleted', {'token' : file.token});
                            eventDispatcher.emit('newFileCompletelyUploaded', {"path": finalFilePath, "checksum" : file.checksum, "size"	 : file['size'], "type" : file.type});
                        });
                    };
                }
                else{
                    socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : _this.sliceSize});
                }
            });
        }
        else{
            socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'size' : this.sliceSize});
        }
    },
    
    /**
     * Create a blobload server.
     * @param port
     *          The port this blobload instance is to start running on.
     * @param sliceSize
     *          The preferred size of slices to use.
     * @param dataBufferLimit
     *          The size limit of the buffer. When this size is reached, cleanup is attempted (clearing the buffer of
     *          all entries for unfinished uploads that have expired since the client disconnected).
     * @param maxConnections
     *          The maximum amount of connections to allow.
     * @param bufferBackupTimeInSeconds
     *          The amount of time to keep unfinished upload data in the buffer before deleting them after a client disconnects.
     * @param tempFolderPath
     *          The path of the directory to use to store currently uploading files (absolute or relative to the directory this module is in).
     * @param storageFolderPath
     *          The path of the directory to use to store finished uploads (absolute or relative to the directory this module is in).
     * @param authorizer
     *          The authorizer function to use for authentication. The token received from the client is passed on to this authorizer function as the first parameter.
     *          The second parameter passed on to the authorizer function is the callback function to execute after validating the token.
     *          The callback function has the following signature: function(string, boolean). The first string parameter represents the error message if validation failed (null otherwise).
     *          The second boolean parameter represents the result of the validation.
     *          So if validation failed due to an invalid token for instance, an example usage of the callback function would be: callback("Invalid token", false).
     * @returns {BlobloadServer} This blobload server (for function chaining purposes).
     */
    setup : function (port, sliceSize, dataBufferLimit, maxConnections, bufferBackupTimeInSeconds, tempFolderPath, storageFolderPath, authorizer){
        if(port > 0) this.port = port;
        if(sliceSize > 0) this.sliceSize = sliceSize;
        if(dataBufferLimit > this.sliceSize) this.dataBufferLimit = dataBufferLimit;
        if(maxConnections > 0) this.maxConnectionsAllowed = maxConnections;
        if(bufferBackupTimeInSeconds > 0) this.bufferBackupTimeInSeconds = bufferBackupTimeInSeconds;
        if(tempFolderPath) this.tempFolderPath = (tempFolderPath.charAt(tempFolderPath.length -1) == '/') ? tempFolderPath : (tempFolderPath + '/');
        if(storageFolderPath) this.storageFolderPath = (storageFolderPath.charAt(storageFolderPath.length -1) == '/') ? storageFolderPath : (storageFolderPath + '/');
    
        // create an all purpose authorizer if none is provided
        if(! authorizer){
            authorizer = function(token, callback){
                callback(null, true);
            }
        }

        this.setHttpAccessData(505, "This ain't no web server");

        var _this = this;
        this.httpServer = http.createServer(function (req, res) {
            eventDispatcher.emit("webPageAccessDetected");
            res.writeHead(_this.getHttpAccessStatusCode());
            return res.end(_this.getHttpAccessContent());
        });
    
        var ioServer = io.listen(this.httpServer);
    
        ioServer.configure(function (){
            ioServer.set('authorization', function (handshakeData, callback) {
                if(_this.currentNbOfConnections > _this.maxConnectionsAllowed){
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
                _this.processNewUpload(socket, data);
            });
    
            socket.on('SendSlice', function (data){
                _this.processSlice(socket, data);
            });
    
            socket.on('disconnect', function () {
                _this.currentNbOfConnections--;
            });

            _this.currentNbOfConnections++;
        });
    
        return this;
    },

    /**
     * Stop this blobload server. This closes the server and stops repetitive cache cleanup.
     * @returns {BlobloadServer} This blobload server (for function chaining purposes).
     */
    stop : function(){
        this.httpServer.close();
        CacheCleaner.stop();
        eventDispatcher.emit('serverStopped');
        return this;
    },

    /**
     * Start this blobload server. This starts the server and the repetitive cache cleanup functionality.
     * @returns {BlobloadServer} This blobload server (for function chaining purposes).
     */
    start : function(){
        this.httpServer.listen(this.port);
        CacheCleaner.start(1000 * 60);
        eventDispatcher.emit('serverStarted');
        return this;
    },

    /**
     * Get the location of a file currently being uploaded.
     * @param token
     *          The token of the file.
     * @returns {string} The computed location of the file if there's a record for it in the buffer. Null otherwise.
     */
    getFileLocation : function(token){
        return this.buffer[token] ? (this.tempFolderPath + token + '.' + this.buffer[token].type) : null;
    },

    /**
     * Set the HTTP access data.
     * @param status
     *          The HTTP access status to set.
     * @param content
     *          The HTTP access content to set.
     * @returns {BlobloadServer} This blobload server (for function chaining purposes).
     */
    setHttpAccessData : function(status, content){
        this.httpAccessStatusCode = status;
        this.httpAccessContent = content;
        return this;
    },

    /**
     * Set the port of this blobload server.
     * @param port
     *          The port to set.
     * @returns {BlobloadServer} This blobload server (for function chaining purposes).
     */
    setPort : function(port){
        this.port = port;
        return this;
    }
}

/**
 * The cache cleanup object.
 * @type {{cleanupActive: boolean, timer: null, run: Function, start: Function, stop: Function}}
 */
var CacheCleaner = {

    /**
     * Indicator of whether the cache cleanup is currently being executed (used as a semaphore to prevent multiple executions of the cleanup function at the same time).
     */
    cleanupActive : false,

    /**
     * The timer used to schedule the repetitive cache cleanup.
     */
    timer : null,

    /**
     * Run the cleanup.
     * Note: This is an internal function meant to be private. Never call!
     */
    run : function(){
        if(this.cleanupActive){
            return;
        }

        this.cleanupActive = true;

        eventDispatcher.emit('bufferCleanUpStarted');

        for(var file in this.buffer){
            var expiryDate = new Date(file.lastUpdated).setSeconds(file.lastUpdated.getSeconds() + this.bufferBackupTimeInSeconds);
            if(Date.now() > expiryDate){
                eventDispatcher.emit('foundExpiredUpload', {'file' : file});
                delete file; // TODO: check if ok or should be replaced with delete by token

                var fileLocation = this.getFileLocation(file.token);
                fs.unlink(fileLocation, function(err){
                    if(err) console.log('Error occurred while deleting "' + fileLocation + '" after buffer cleanup for that upload');
                });
            }
        }

        eventDispatcher.emit('bufferCleanUpFinished');

        this.cleanupActive = false;
    },

    /**
     * Start the repetitive cache cleanup.
     * @param interval
     *          The interval between cleanup checks (in milliseconds).
     */
    start : function(interval){
        this.stop();
        this.run();
        this.timer = setInterval(this.run, interval);
    },

    /**
     * Stop the repetitive cleanup.
     */
    stop : function(){
        if(this.timer) clearInterval(this.timer);
    }
}

/**
 * Module exports.
 */
exports.setup = function(port, sliceSize, dataBufferLimit, maxConnections, bufferBackupTimeInSeconds, tempFolderPath, storageFolderPath, authorizer){
    return BlobloadServer.setup(port, sliceSize, dataBufferLimit, maxConnections, bufferBackupTimeInSeconds, tempFolderPath, storageFolderPath, authorizer);
}
exports.start = function(){
    return BlobloadServer.start();
}
exports.stop = function(){
    return BlobloadServer.stop();
}
exports.setHttpAccessData = function(status, content){
    return BlobloadServer.setHttpAccessData(status, content);
}
exports.setPort = function(port){
    return BlobloadServer.setPort(port);
}
exports.eventDispatcher = eventDispatcher;