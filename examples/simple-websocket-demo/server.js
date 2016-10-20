import RPLidar from '../../src/rplidar';
import Primus from 'primus';
import http from 'http';
import urlParser from 'url';
import fs from 'fs';
import path from 'path';

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
<script type="text/javascript" src="client.js"></script>
</head>
<button id="start">Start Scanning</button>
<button id="stop">Stop Scanning</button>
</html>`);
            break;
        case '/client.js':
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            fs.createReadStream(path.join(__dirname, 'client.js')).pipe(res);
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

    lidar.on('data', data => spark.write(data));

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
