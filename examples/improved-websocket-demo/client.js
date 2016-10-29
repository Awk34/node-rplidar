const sp = window.schemapack;
const d3 = window.d3;
var primus = new Primus();

const scanPacketSchema = sp.build({
    start: 'boolean',
    quality: 'uint8',   // 6 bits
    angle: 'float32',   // 15 bits / 64
    distance: 'float32' // 16 bits / 4
});

document.addEventListener('DOMContentLoaded', function() {
    const startButton = document.getElementById('start');
    const stopButton = document.getElementById('stop');

    const width = window.innerWidth - 100;
    const height = window.innerHeight - 100;
    const radius = Math.min(width, height) / 2 - 100;

    var r = d3.scale.linear()
        .domain([0, 7])
        .range([0, radius]);

    var svg = d3.select('body').append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', `translate(${width / 2},${height / 2})`);

    // Radiuses
    var gr = svg.append('g')
        .attr('class', 'r axis')
        .selectAll('g')
        .data(r.ticks(7).slice(1))
        .enter().append('g');

    // Radius dotted circles
    gr.append('circle')
        .attr('r', r);

    // Radius labels
    gr.append('text')
        .attr('y', d => -r(d) - 4)
        .attr('transform', 'rotate(15)')
        .style('text-anchor', 'middle')
        .text(d => `${d}m`);

    // Angles
    var ga = svg.append('svg:g')
        .attr('class', 'a axis')
        .selectAll('g')
        .data(d3.range(0, 360, 30))
        .enter().append('g')
        .attr('transform', d => `rotate(${-d})`);

    // Degree dotted lines
    ga.append('line')
        .attr('x2', radius);

    // Degree labels
    ga.append('text')
        .attr('x', radius + 6)
        .attr('dy', '.35em')
        .style('text-anchor', d => d < 270 && d > 90 ? 'end' : null)
        .attr('transform', d => d < 270 && d > 90 ? `rotate(180 ${(radius + 6)},0)` : null)
        .text(d => `${d}\u00B0`);

    let root = svg.append('svg:g').attr('id', 'data');

    function refresh() {
        let points = root.selectAll('circle')
            .data(data, d => d.angle);

        points
            .enter()
            .append('svg:circle')
            .attr('class', 'point')
            .style('opacity', 1)
            .attr('r', 2)
            .attr('cx', d => d.distance * -Math.cos(d.angle * Math.PI / 180) * (radius / 7000))
            .attr('cy', d => d.distance * -Math.sin(d.angle * Math.PI / 180) * (radius / 7000))
            .attr('data-distance', d => d.distance)
            .attr('data-angle', d => d.angle);

        points.exit()
            .remove();
    }

    let data = [];

    startButton.addEventListener('click', () => {
        primus.write('start');
    });
    stopButton.addEventListener('click', () => {
        primus.write('stop');
    });

    primus.open();
    primus.on('data', function(d) {
        d = scanPacketSchema.decode(d);
        if(d.quality < 10 || d.distance < 100) return;
        if(data.length > 500) data = data.slice(1);
        // console.log(scanPacketSchema.decode(d));
        data.push(d);
        // refresh();
        // console.log('Received a new message from the server', data);
    });

    setInterval(refresh, 10);
});
