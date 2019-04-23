'use strict'

import Avc from 'broadway/Decoder'
import YUVWebGLCanvas from 'canvas/YUVWebGLCanvas'
import YUVCanvas from 'canvas/YUVCanvas'
import Size from 'utils/Size'
import { EventEmitter } from 'events'

import debug from 'debug' // ?? why?

const SOCKET_MAGIC_BYTES = 'wsh264';

const log = debug('wsavc')

function buf2hex(bytes) { // buffer is an ArrayBuffer
    const data = bytes.subarray(0, 10);
    return Array.prototype.map.call(data, x => ('00' + x.toString(16)).slice(-2)).join('');
}

class WSAvcPlayer extends EventEmitter {
    constructor (canvas, canvastype, useWorker) {
        super()
        this.canvas = canvas
        this.canvastype = canvastype
        this.now = new Date().getTime()
        // AVC codec initialization
        // this.avc = new DecoderAsWorker(canvastype)

        this.avc = new Avc()

        // TODO: figure out why this was here
        /* if (false) this.avc.configure({
            filter: 'original',
            filterHorLuma: 'optimized',
            filterVerLumaEdge: 'optimized',
            getBoundaryStrengthsA: 'optimized',
        }) */

        // WebSocket variable
        this.ws
        this.pktnum = 0
        this.sequenceStarted = false

        this.avc.onPictureDecoded = (e, w, h, ...rest) => {
            return this.initCanvas(w, h, [ e, w, h, ...rest ])
        }

    }

    decode (data) {
        let naltype = 'invalid frame'
        // TODO fix type recog: const frameType = data[0] & 0x1f
        /*
        0      Unspecified                                                    non-VCL
        1      Coded slice of a non-IDR picture                               VCL
        2      Coded slice data partition A                                   VCL
        3      Coded slice data partition B                                   VCL
        4      Coded slice data partition C                                   VCL
        5      Coded slice of an IDR picture                                  VCL
        6      Supplemental enhancement information (SEI)                     non-VCL
        7      Sequence parameter set                                         non-VCL
        8      Picture parameter set                                          non-VCL
        9      Access unit delimiter                                          non-VCL
        10     End of sequence                                                non-VCL
        11     End of stream                                                  non-VCL
        12     Filler data                                                    non-VCL
        13     Sequence parameter set extension                               non-VCL
        14     Prefix NAL unit                                                non-VCL
        15     Subset sequence parameter set                                  non-VCL
        16     Depth parameter set                                            non-VCL
        17..18 Reserved                                                       non-VCL
        19     Coded slice of an auxiliary coded picture without partitioning non-VCL
        20     Coded slice extension                                          non-VCL
        21     Coded slice extension for depth view components                non-VCL
        22..23 Reserved                                                       non-VCL
        24..31 Unspecified                                                    non-VCL

        */
        if (data.length > 4) {
            if (data[4] === 0x65) {
                naltype = 'I frame'
            }
            else if (data[4] === 0x41) {
                naltype = 'P frame'
            }
            else if (data[4] === 0x67) {
                naltype = 'SPS'
            }
            else if (data[4] === 0x68) {
                naltype = 'PPS'
            }
        }
        console.info(`Passed ${ naltype } to decoder ${ data[4] & 0x1f }`)
        /* const now_new = new Date().getTime()
        const elapsed = now_new - this.now
        this.now = now_new
        console.log(1000 / elapsed) */
        console.log(buf2hex(data)); // = 04080c10

        this.avc.decode(data)
    }

    connect (url) {

        // Websocket initialization
        if (this.ws !== undefined) {
            this.ws.close()
            delete this.ws
        }
        this.ws = new WebSocket(url)
        this.ws.binaryType = 'arraybuffer'

        this.ws.onopen = () => {
            log('Connected to ' + url)
            this.emit('connected', url)
        }


        let framesList = []

        const decodeNalu = function (data) {
            var l = data.length;
            var foundSomething = false;
            var lastFound = 0;
            var lastStart = 0;
            const nals = [];
            for (var i = 0; i < l; ++i) {
              if (data[i] === 1){
                if (
                  data[i - 1] === 0 &&
                  data[i - 2] === 0
                ){
                    var startPos = i - 2;
                    if (data[i - 3] === 0) {
                        startPos = i - 3;
                    };
                    // its a nal;
                    if (foundSomething) {
                        nals.push({
                        offset: lastFound,
                        end: startPos,
                        type: data[lastStart] & 31
                        });
                    };
                    lastFound = startPos;
                    lastStart = startPos + 3;
                    if (data[i - 3] === 0) {
                        lastStart = startPos + 4;
                    };
                    foundSomething = true;
                }
              }
            }
            if (foundSomething) {
                nals.push({
                    offset: lastFound,
                    end: i,
                    type: data[lastStart] & 31
                });
            }

            for (i = 0; i < nals.length; ++i) {
                const { offset, end, type } = nals[i] || {};
                const buf = data.subarray(offset, end);
                framesList.push(buf);
            }
    
            // if (nals.length > 0) {
            //     this.stream.push({ data, nals })
            // }
        }

        this.ws.onmessage = (evt) => {
            if (typeof evt.data == 'string') {
                return this.cmd(JSON.parse(evt.data))
            }
            var messageData = new Uint8Array(evt.data);
            if( !this.sequenceStarted ) {
                this.decodeSocketHeader(messageData);
                // this.scheduleAnimation();
                return;
            }
            decodeNalu(messageData);

            this.pktnum++
            // log("[Pkt " + this.pktnum + " (" + evt.data.byteLength + " bytes)]");
            // this.decode(frame);
            // framesList.push(frame)
        }


        let running = true

        const shiftFrame = function () {
            if (!running)
                return


            // if (framesList.length > 30) {
            //     log('Dropping frames', framesList.length)
            //     const vI = framesList.findIndex(e => (e[4] & 0x1f) === 7)
            //     // console.log('Dropping frames', framesList.length, vI)
            //     if (vI >= 0) {
            //         framesList = framesList.slice(vI)
            //     }
            //     // framesList = []
            // }
            var pic = 0;
            setTimeout(function foo() {
                const frame = framesList.shift()
                this.emit('frame_shift', framesList.length)
                frame && this.decode(frame)
                pic ++;
                if (pic < 3000) {
                    setTimeout(foo.bind(this), 20);
                };
            }.bind(this), 20);
            // requestAnimationFrame(shiftFrame)
        }.bind(this)

        shiftFrame()


        this.ws.onclose = () => {
            running = false
            this.emit('disconnected')
            log('WSAvcPlayer: Connection closed')
        }

        return this.ws
    }

    decodeSocketHeader(data) {
        if(
            data[0] === SOCKET_MAGIC_BYTES.charCodeAt(0) &&
            data[1] === SOCKET_MAGIC_BYTES.charCodeAt(1) &&
            data[2] === SOCKET_MAGIC_BYTES.charCodeAt(2) &&
            data[3] === SOCKET_MAGIC_BYTES.charCodeAt(3) &&
            data[4] === SOCKET_MAGIC_BYTES.charCodeAt(4) &&
            data[5] === SOCKET_MAGIC_BYTES.charCodeAt(5)
        ) {
            this.width = (data[6] * 256 + data[7]);
            this.height = (data[8] * 256 + data[9]);
            this.sequenceStarted = true;
            this.ws.send('v_002'); // 请求开始传输
        }
    }

    initCanvas (width, height, dec) {
        const canvasFactory = this.canvastype === 'webgl' || this.canvastype === 'YUVWebGLCanvas'
            ? YUVWebGLCanvas
            : YUVCanvas

        const canvas = new canvasFactory(this.canvas, new Size(width, height))
        this.avc.onPictureDecoded = (e, w, h, ...rest) => {
            // console.log(rest)
            if (w !== width || h !== height) {
                return this.initCanvas(w, h, [ e, w, h, ...rest ])
            }
            return canvas.decode(e, w, h, ...rest)
        }
        this.canvas.style = `width:100%; height:${ height / width * 100 }vh;`
        this.canvas.width = width
        this.canvas.height = height

        if (dec) {
            return canvas.decode(...dec)
        }


    }

    cmd (cmd) {
        log('Incoming request', cmd)
        switch (cmd.action) {
        case 'initalize': {
            const { width, height } = cmd.payload
            // this.initCanvas(width, height)
            return this.emit('initalized', cmd.payload)

        }
        default:
            return this.emit(cmd.action, cmd.payload)
        }
    }

    disconnect () {
        this.ws.close()

    }
    // only send json!
    send (action, payload) {
        return this.ws.send(JSON.stringify({ action, payload }))
    }
}

module.exports = WSAvcPlayer
module.exports.debug = debug