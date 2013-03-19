var app = require('http').createServer(handler)
  , io = require('socket.io').listen(app)
  , fs = require('fs')
  , exec = require('child_process').exec
  , util = require('util')
  , Files = {}
  , sliceSize = 524288;

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
        // look up file, if it doesn't exist, create it
        var file = Files[data['token']];
        if(file === undefined){
            file = Files[data['token']] = {
                token : data['token'],
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
	});
	
	socket.on('SendSlice', function (data){
        var file = Files[data['token']];
			file.byteBuffer += data['slice'];
            file.bytePointer += sliceSize;
			if(file.bytePointer >= file.size) {
				fs.write(file.handler, file.byteBuffer, null, 'Binary', function(err, Writen){
					var inp = fs.createReadStream('temp/' + file.token + '.' + file.type);
					var out = fs.createWriteStream('comp/' + file.token + '.' + file.type);
					util.pump(inp, out, function(){
						fs.unlink('temp/' + file.token + '.' + file.type, function () {
                            // you can hook up other services here
                            socket.emit('FileCompleted', {'token' : file.token});
						});
					});
				});
			}
			else if(file.byteBuffer.length > 10485760){ //If the Data Buffer reaches 10MB
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
