import RPLidar from '../../src/rplidar';
import Primus from 'primus';
import http from 'http';
import urlParser from 'url';
import fs from 'fs';
import path from 'path';
import sp from 'schemapack';

const scanPacketSchema = sp.build({
    start: 'boolean',
    quality: 'uint8',   //uint6
    angle: 'float32',    //uint15
    distance: 'float32'
});

const hostname = '127.0.0.1';
const port = 3000;

const server = http.Server();
const primus = new Primus(server, {transformer: 'uws'});

/**
 * HTTP SERVER
 */

server.on('request', (req, res) => {
    let url = urlParser.parse(req.url);

    switch(url.pathname) {
        case '/':
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            res.end(`
<html>
<head>
<script type="text/javascript">${primus.library()}</script>
<script type="text/javascript" src="schemapack.min.js"></script>
<script src="https://d3js.org/d3.v3.min.js"></script>
<script type="text/javascript" src="client.js"></script>
<style>
.frame {
  fill: none;
  stroke: #000;
}

.axis text {
  font: 10px sans-serif;
}

.axis line,
.axis circle {
  fill: none;
  stroke: #777;
  stroke-dasharray: 1,4;
}

.axis :last-of-type circle {
  stroke: #333;
  stroke-dasharray: none;
}

.line {
  fill: none;
  stroke: red;
  stroke-width: 1.5px;
}

.point {
  fill: red;
}
</style>
</head>
<button id="start">Start Scanning</button>
<button id="stop">Stop Scanning</button>
<br>
</html>`);
            break;
        case '/client.js':
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            fs.createReadStream(path.join(__dirname, 'client.js')).pipe(res);
            break;
        case '/schemapack.min.js':
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            fs.createReadStream(path.join(__dirname, '..', 'schemapack.min.js')).pipe(res);
            break;
        case '/favicon.ico':
        default:
            console.log(url.pathname);
            res.statusCode = 404;
            res.end();
    }
});

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});

let lidar = new RPLidar();

/**
 * WebSockets
 */

primus.on('connection', function(spark) {
    console.log(`spark ${spark.id} connected`);

    lidar.on('data', data => {
        // console.log(data);
        // let jsonEncoded = JSON.stringify(data);
        let spEncoded = scanPacketSchema.encode(data);
        // byteCount('JSON', jsonEncoded.length);
        // byteCount('SchemaPack', spEncoded.length, jsonEncoded.length);
        spark.write(spEncoded);
    });

    spark.on('data', function message(data) {
        if(data === 'start') {
            lidar.scan();
        } else if(data === 'stop') {
            lidar.stop();
        } else {
            console.log(data);
        }
    });
});
primus.on('disconnection', function(spark) {
    console.log(`spark ${spark.id} disconnected`);
});

lidar.init().then(async () => {
    let health = await lidar.getHealth();
    console.log('health: ', health);

    let info = await lidar.getInfo();
    console.log('info: ', info);

    lidar.reset();
});

function byteCount(testName, len, baseLen) {
    console.log(testName + ' Byte Count: ' + len + (baseLen ? ', ' + Math.round(len / baseLen * 100) + '%' : ''));
}
// { start: false, quality: 31, angle: 111.734375, distance: 285.25 }
// JSON Byte Count: 65
// SchemaPack Byte Count: 6, 9%
