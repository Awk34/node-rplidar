import RPLidar from '../../src/rplidar';

let lidar = new RPLidar();

lidar.on('data', console.log);

lidar.init().then(async () => {
    let health = await lidar.getHealth();
    console.log('health: ', health);

    let info = await lidar.getInfo();
    console.log('info: ', info);

    // await lidar.scan();
    lidar.reset();
});
