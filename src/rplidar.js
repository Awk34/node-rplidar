import _ from 'lodash';
import SerialPort from 'serialport';
import { BitView } from 'bit-buffer';
import { EventEmitter } from 'events';

const DEBUG = process.env.NODE_ENV === 'development';

function wait(time) {
    return new Promise(respond => {
        setTimeout(respond, time);
    });
}

const DEFAULT_SERIALPORT_PATH = 'COM3'; // /dev/ttyUSB0

const START_FLAG = 0xA5;
const START_FLAG2 = 0x5A;
const COMMANDS = _.mapValues({
    STOP: 0x25,
    RESET: 0x40,
    SCAN: 0x20,
    EXPRESS_SCAN: 0x82,
    FORCE_SCAN: 0x21,
    GET_INFO: 0x50,
    GET_HEALTH: 0x52,
    GET_SAMPLERATE: 0x59,
    GET_ACC_BOARD_FLAG: 0xFF,
    SET_MOTOR_PWM: 0xF0,
}, command => Buffer.from([START_FLAG, command]));

const RESPONSE_MODES = {
    SINGLE_REQUEST_SINGLE_RESPONSE: 0x0,
    SINGLE_REQUEST_MULTIPLE_RESPONSE: 0x1,
    RESERVED_3: 0x3,
    RESERVED_$: 0x4,
    NO_RESPONSE: 5,
};

const RESPONSES = {
    SCAN_START: {
        responseMode: RESPONSE_MODES.SINGLE_REQUEST_MULTIPLE_RESPONSE,
        bytes: [START_FLAG, START_FLAG2, 0x05, 0x00, 0x00, 0x40, 0x81],
    },
    HEALTH: {
        responseMode: RESPONSE_MODES.SINGLE_REQUEST_SINGLE_RESPONSE,
        bytes: [START_FLAG, START_FLAG2, 0x03, 0x00, 0x00, 0x00, 0x06],
        dataLength: 3, // Bytes
    },
    INFO: {
        responseMode: RESPONSE_MODES.SINGLE_REQUEST_SINGLE_RESPONSE,
        bytes: [START_FLAG, START_FLAG2, 0x14, 0x00, 0x00, 0x00, 0x04],
        dataLength: 20,
    },
};

// Start Flag   | Command | Payload Size | Payload Data | Checksum
// 1byte (0xA5) | 1byte   | 1byte        | 0-255 bytes  | 1byte
//                                Optional Section, ≤5 seconds
//
// checksum = 0 ⨁ 0𝑥𝐴5 ⨁ 𝐶𝑚𝑑𝑇𝑦𝑝𝑒 ⨁ 𝑃𝑎𝑦𝑙𝑜𝑎𝑑𝑆𝑖𝑧𝑒 ⨁ 𝑃𝑎𝑦𝑙𝑜𝑎𝑑[0] ⨁ … ⨁ 𝑃𝑎𝑦𝑙𝑜𝑎𝑑[𝑛]

// Start Flag1  | Start Flag2  | Data Response Length | Send Mode | Data Type
// 1byte (0xA5) | 1byte (0x5A) | 30bits               | 2bits     | 1byte

const RPLIDAR_STATES = {
    UNKNOWN: 0,
    IDLE: 1,
    PROCESSING: 2,
    SCANNING: 3,
    STOP: 4
};

const MOTOR_STATES = {
    OFF: 0,
    ON: 1
};

const HEALTH_STATUSES = new Map();
HEALTH_STATUSES.set(0x00, 'Good');
HEALTH_STATUSES.set(0x01, 'Warning');
HEALTH_STATUSES.set(0x02, 'Error');

const RESPONSE_TYPES = {
    SCAN: 0,
    EXPRESS_SCAN: 1,
    FORCE_SCAN: 2,
    INFO: 3,
    HEALTH: 4,
    SAMPLERATE: 5,
};

export default class RPLidar extends EventEmitter {
    state = RPLIDAR_STATES.UNKNOWN;
    waitingFor;

    // The motor seems to always start as off
    motorState = MOTOR_STATES.OFF;

    static parser() {
        let _scanCache = new Buffer(0);

        return function(emitter, buffer) {
            if(isHealthCheckResponse(buffer)) {
                emitter.emit('health', {
                    status: parseInt(`${hexToBinaryString(buffer[7])}`, 2),
                    errorCode: parseInt(`${hexToBinaryString(buffer[9])}${hexToBinaryString(buffer[8])}`, 2)
                });
            } else if(isInfoCheckResponse(buffer)) {
                emitter.emit('info', parseInfo(buffer));
            } else if(isScanStart(buffer)) {
                emitter.emit('scan-start');
            } else if(isBootUpMessage(buffer)) {
                this.emit('boot', String(buffer));
            } else if(buffer.length === 256) {
                try {
                    // add any extra bytes left off from the last buffer
                    let data = Buffer.concat([_scanCache, buffer]);
                    let dataLength = data.length;
                    let extraBits = dataLength % 5;

                    for(let offset = 0; offset < dataLength - extraBits; offset += 5) {
                        emitter.emit('data', parseScan(data.slice(offset, offset + 5)));
                    }

                    // add any bits that don't make up a complete data packet to the cache
                    _scanCache = data.slice(dataLength - extraBits, dataLength);
                } catch(err) {
                    emitter.emit('error', err);
                }
            } else {
                if(DEBUG) console.log('Unknown packet');
            }
        }
    }

    constructor(path = DEFAULT_SERIALPORT_PATH, options = {}) {
        super();

        this.path = path;
        this.debug = !!options.debug;
    }

    init() {
        return new Promise((resolve, reject) => {
            if(this._port) setTimeout(reject());

            this._port = new SerialPort(this.path, {
                baudrate: 115200,
                buffersize: 256,
                parser: RPLidar.parser()
            });

            this._port.on('error', err => this.emit('error', err));
            this._port.on('disconnect', () => this.emit('disconnect'));
            this._port.on('close', () => this.emit('close'));
            this._port.on('data', data => {
                if(this.state !== RPLIDAR_STATES.SCANNING) {
                    // console.log('GARBAGE', data);
                    // probably a lost packet fragment from an ungraceful shutdown during scanning. Throw it away.
                } else {
                    this.emit('data', data);
                    if(DEBUG) console.log(data);
                }
            });
            this._port.on('health', health => this.emit('health', health));

            this._port.on('open', () => {
                this._port.flush(err => {
                    if(err) return reject(err);

                    this.state = RPLIDAR_STATES.IDLE;

                    this.emit('ready');
                    resolve();
                });
            });
        });
    }

    getHealth() {
        this.state = RPLIDAR_STATES.PROCESSING;
        this.waitingFor = 'HEALTH'; // REPLIES.HEALTH
        this._port.write(COMMANDS.GET_HEALTH);

        return new Promise((resolve, reject) => {
            this._port.once('health', health => {
                resolve(health);
                this.waitingFor = false;
            });
        });
    }

    getInfo() {
        this.state = RPLIDAR_STATES.PROCESSING;
        this.waitingFor = 'INFO';
        this._port.write(COMMANDS.GET_INFO);

        return new Promise((resolve, reject) => {
            this._port.once('info', info => {
                resolve(info);
                this.waitingFor = false;
            });
        });
    }

    /**
     * Resets the RPLidar
     *
     * @returns Promise
     */
    reset() {
        this._port.write(COMMANDS.RESET);

        return new Promise(resolve => {
            this._port.once('boot', (/*bootMessage*/) => {
                // if debug log bootMessage
                resolve();
            });
        });
    }

    startMotor() {
        this._port.set({dtr: false});
        this.motorState = MOTOR_STATES.ON;

        return wait(5);
    }

    stopMotor() {
        this._port.set({dtr: true});
        this.motorState = MOTOR_STATES.OFF;

        return wait(5);
    }

    scan() {
        // If the motor is off, we need to start it first
        let motorPromise;
        if(this.motorState === MOTOR_STATES.OFF) {
            motorPromise = this.startMotor();
        } else {
            motorPromise = new Promise(resolve => setTimeout(resolve));
        }

        return motorPromise.then(() => {
            this.state = RPLIDAR_STATES.PROCESSING;
            this.waitingFor = 'SCAN_START';
            this._port.write(COMMANDS.SCAN);

            return new Promise((resolve, reject) => {
                this._port.once('scan-start', () => {
                    this.state = RPLIDAR_STATES.SCANNING;
                    this.waitingFor = 'SCAN';
                    resolve();
                });
            });
        });
    }

    stopScan() {
        this._port.write(COMMANDS.STOP);

        return wait(1);
    }
}

function isHealthCheckResponse(buffer) {
    if(buffer.length !== 10) return false;

    return buffer[0] === START_FLAG
        && buffer[1] === 0x5A
        && buffer[2] === 0x03
        && buffer[3] === 0x00
        && buffer[4] === 0x00
        && buffer[5] === 0x00
        && buffer[6] === 0x06;
}

function isInfoCheckResponse(buffer) {
    if(buffer.length !== RESPONSES.INFO.bytes.length + RESPONSES.INFO.dataLength) return false;

    for(let i = 0; i < RESPONSES.INFO.bytes.length; i++) {
        if(buffer[i] !== RESPONSES.INFO.bytes[i]) return false;
    }

    return true;
}

function isScanStart(buffer) {
    if(buffer.length !== 7) return false;

    return buffer[0] === START_FLAG
        && buffer[1] === 0x5A
        && buffer[2] === 0x05
        && buffer[3] === 0x00
        && buffer[4] === 0x00
        && buffer[5] === 0x40
        && buffer[6] === 0x81;
}

function isBootUpMessage(buffer) {
    if(buffer.length !== 56) return false;

    return buffer[0] === 0x52
        && buffer[1] === 0x50
        && buffer[2] === 0x20
        && buffer[3] === 0x4c
        && buffer[4] === 0x49
        && buffer[5] === 0x44
        && buffer[6] === 0x41
        && buffer[7] === 0x52;
}

function parseInfo(buffer) {
    return {
        model: buffer[7],
        firmware_minor: buffer[8],
        firmware_major: buffer[9],
        hardware: buffer[10],
        serial_number: _.reduce(buffer.slice(11, 27), (acc, item) => `${acc}${item.toString(16)}`, ''),
    };
}

function hexToBinaryString(hex) {
    return _.padStart((hex >>> 0).toString(2), 8, '0');
}

function parseScan(data) {
    let byte0 = hexToBinaryString(data[0]);
    let byte1 = hexToBinaryString(data[1]);
    let byte2 = hexToBinaryString(data[2]);
    let byte3 = hexToBinaryString(data[3]);
    let byte4 = hexToBinaryString(data[4]);

    let bb = new BitView(data);

    if(DEBUG) console.log(`${byte0} ${byte1} ${byte2} ${byte3} ${byte4}`);

    let quality = bb.getBits(2, 6, false);

    let start = byte0.substring(7, 8);
    let inverseStart = byte0.substring(6, 7);
    if(start === inverseStart) throw new Error('ParseError: !S === S');

    let C = byte1.substring(7, 8);
    if(C != 1) throw new Error('ParseError: C not 1');

    let angle = bb.getBits(9, 15, false) / 64.0; // 0-360 deg
    if(angle < 0 || angle > 360) throw new Error('ParseError: Angle parsed outside 0-360 range');

    let distance = bb.getBits(24, 16, false) / 4.0; // mm

    return {
        start,
        quality,
        angle,
        distance
    };
}

module.exports = RPLidar;
