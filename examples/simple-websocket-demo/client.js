var primus = new Primus();

document.addEventListener('DOMContentLoaded', function() {
    let startButton = document.getElementById('start');
    let stopButton = document.getElementById('stop');

    startButton.addEventListener('click', () => {
        primus.write('start');
    });
    stopButton.addEventListener('click', () => {
        primus.write('stop');
    });

    primus.open();
    primus.on('data', function(data) {
        console.log('Received a new message from the server', data);
    });
});
