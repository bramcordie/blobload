var app = require('http').createServer(handler),    // initialize an HTTP server
    io = require('socket.io').listen(app),          // initialize a socket to listen on the HTTP server
    fs = require('fs'),                             // initialize a file system handler
    exec = require('child_process').exec,           // initialize a system process handler (used here for executing HandBrake commands)
    util = require('util'),                         // the util object is needed to move uploaded files later
    Files = {},
    sliceSize = 524288,
    dataBufferLimit = 10485760 /*10MB*/,            // the data buffer limit
    tokenVerificationURL = '';                      // the web path of the token verification service. [checksum] is
                                                    // substituted with the actual checksum and [token] with the token

app.listen(1337);

function handler (req, res) {
  fs.readFile(__dirname + '/index.html',
  function (err, data) {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading index.html');
    }
    res.writeHead(200);
    res.end(data);
  });
}

io.sockets.on('connection', function (socket) {
  	socket.on('NewFile', function (data) {
        checkTokenValidity(data['token'], data['checksum'], function(isValidToken, err){
            if(isValidToken)
            {
                // look up file, if it doesn't exist, create it
                var file = Files[data['token']];
                if(file === undefined){
                    file = Files[data['token']] = {
                        token : data['token'],
                        tokenVerified : true, // redundantly stored here to avoid requerying the verification service upon future requests
                        checksum : data['checksum'],
                        size	 : data['size'],
                        bytePointer : 0,
                        type : data['type']
                    }
                }
                try{
                    var Stat = fs.statSync('temp/' + file.token + '.' + file.type);
                    if(Stat.isFile())
                    {
                        file.bytePointer = Stat.size;
                    }
                }
                catch(er){} //It's a New File
                fs.open('temp/' + file.token + '.' + file.type, 'a', 0755, function(err, fd){
                    if(err)
                    {
                        console.log(err);
                    }
                    else
                    {
                        file.handler = fd; //We store the file handler so we can write to it later
                        socket.emit('WantSlice', { 'token' : file.token, 'pointer': file.bytePointer, 'size' : sliceSize});
                    }
                });
            }
            else
            {
                socket.emit('EncounteredError', {'error': err, 'result': 'Token validation failed', 'data': data});
            }
        });
	});
	
	socket.on('SendSlice', function (data){
        var file = Files[data['token']];

        if(! file){
            socket.emit('EncounteredError', {'error': 'File not found', 'data': data});
            return;
        }

        file.byteBuffer += data['slice'];
        file.bytePointer += sliceSize;
        if(file.bytePointer >= file.size) {
            fs.write(file.handler, file.byteBuffer, null, 'Binary', function(err, Writen){
                var inp = fs.createReadStream('temp/' + file.token + '.' + file.type);
                var out = fs.createWriteStream('comp/' + file.token + '.' + file.type);
                inp.pipe(out, {});
                out.end = function(){
                    fs.unlink('temp/' + file.token + '.' + file.type, function () {
                        // you can hook up other services here
                        socket.emit('FileCompleted', {'token' : file.token});
                    })};
            });
        }
        else if(file.byteBuffer.length > dataBufferLimit){
            fs.write(file.hanlder, file.byteBuffer, null, 'Binary', function(err, Writen){
                file.byteBuffer = "";
                socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'slice' : sliceSize});
            });
        }
        else {
            socket.emit('WantSlice', { 'token' : file.token, 'pointer' : file.bytePointer, 'slice' : sliceSize});
        }
    });
});

/**
 * Check the validity of an upload token.
 */
function checkTokenValidity(token, checksum, callback){
    // basic check for now
    if(! token) callback(false, 'No token present');
    if(Files[token]['tokenVerified']) callback(true);

    http.request(
        {
            host: tokenVerificationURL.substr(0, tokenVerificationURL.indexOf('/')),
            path: tokenVerificationURL.substr(tokenVerificationURL.indexOf('/')).replace('[token]', token).replace('[checksum]', checksum)
        },
        function(response) {
            var responseContent = '';

            response.on('data', function (chunk) {
                responseContent += chunk;
            });

            response.on('end', function () {
                try{
                    responseJSON =JSON.parse(responseContent);
                } catch(e){
                    callback(false, 'Error parsing verification response from token validation service');
                    return;
                }
                if(responseJSON.verified){
                    callback(true);
                }
            });
        }
    ).end();
}
