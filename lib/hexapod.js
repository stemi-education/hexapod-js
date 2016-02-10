/**
 * Node.js library for controling the STEMI hexapod (http:/www.stemi.education/).
 *
 * @author Vlatko Klabucar <vlatko@stemi.education>
 */

var Socket = require('net').Socket;
var _      = require('lodash');
var log    = require('loglevel');
var http   = require('http')

log.setLevel(log.levels.INFO);

var Hexapod = function(ip, port){
  this.connected = false;
  this.ROTATION_TIME = 13; // seconds for 360 deg. turn
  this.MAX_SPEED = 13;     // seconds for 1 m
  this.robotState = 'idle';
  this.cmdStack = [];
  this.currentPacket = new Packet();
  this.ip = ip;
  this.port = port;
  this.intervalSender = undefined; //for sending currentPacket periodically
  this.intervalSetter = undefined; //for setting currentPacket periodically
}

/**
 * STEMI hexapod robot expects to receive binary messages we called 'Packets'.
 * Since these messages contain a lot of parameters, object 'Packet' is introduced
 * for simplicity. Unchanged, it contains all the values necesarry for the robot
 * to stay still. By changing the parameters of Packet we can issue movement
 * commands for the hexapod. This is the short expanation of the parameters
 * and their valid values:
 *
 *  Translational motion:
 *   power - [0..100] speed of the robot
 *   angle - [-180..180] 0 deg -> forward; 90 deg -> right; -90 deg -> left;
 *           180 deg -> back;
 *
 *  Rotational motion:
 *   rotation - [-100..100]; speed and direction of rotation;
 *              [0..100] - clockwise; [-100..0] counterclockwise
 *
 *  Special flags (Tilt bytes are MUTUALY EXCUSIVE):
 *   staticTilt - [0,1] 1 -> enable body tilting according to the accelerometer
 *   movingTilt - [0,1] 1 -> enable body tilting while walking *EXPERIMENTAL*
 *   onOff      - [0,1] 1 -> robot operational; 0 -> robot sleeping *NOT IMPLEMENTED*
 *
 *  Accelerometer (one of the *Tilt bytes must be 1):
 *   Bytes should containe acceleration force in (m/s^2 * 10), saturated at -40 and 40
 *    accX - x axis acceleration
 *    accY - y axis acceleration
 *
 *  Sliders array:
 *   Array of 9 bytes that represent the state of 9 sliers of the Android app.
 *   Has a defualt value of [50, 25, 0, 0, 0, 0, 0, 0, 0]
 *    slidersArray[0]    - [0..100] robot height
 *    slidersArray[1]    - [0..100] gait
 *    slidersArray[2..8] - [0..255] user defined data; this is where users can
 *                         encode the special messages to the robot. Arduino
 *                         firmware needs to be modified in order to utilize
 *                         these bytes.
 *
 *  [EXPERIMENTAL] duration - [0..255] specifies how long will a packet be
 *                            "executed" on a robot. If 0, the robot will go in
 *                            rest state as soon as the timer on robot expires.
 */
 var Packet = function(parameters){
   var defaults = {
     power: 0,
     angle: 0,
     rotation: 0,
     staticTilt: 0,
     movingTilt: 0,
     onOff: 0,
     accX: 0,
     accY: 0,
     slidersArray: [50, 25, 0, 0, 0, 0, 0, 0, 0],
     duration: 0
   }

   if(parameters && parameters.slidersArray && parameters.slidersArray.length !== 9){
     parameters.slidersArray = defaults.slidersArray;
     log.warn('new Packet: slidersArray.length should be exactly 9; defaulting ');
   }

   for(p in parameters){
     this[p.toString()] = parameters[p.toString()];
   }

   _.defaults(this, defaults);
 }

/**
 * Generates a buffer of bytes to be sent to the robot via websocket.
 * STEMI hexapod expects first three bytes to be 'P', 'K', 'T' ASCII chars,
 * followed by 18 bytes representing the Packet.
 *
 * NOTE: angle parameter is divided by 2 to save space (one byte cannot hold
 *       values in [-180..180] range). Multiplying this value by 2 should be done
 *       on the robot side.
 *
 * @returns {Buffer}
 */
Packet.prototype.getBuffer = function(){
  var array = new Uint8Array(21);

  array.set([80, 75, 84, // 'P', 'K', 'T'
             this.power, this.angle/2, this.rotation, this.staticTilt,
             this.movingTilt, this.onOff, this.accX, this.accY]);
  array.set(this.slidersArray, 11);

  array[20] = this.duration;

  return new Buffer(array);
}

/**
 * In order to produce fluid movement, robot expects to receive the commands at
 * a rate of 10Hz. This function sends the currentPacket every 100 ms over
 * persistent TCP connection, just like a smartphone app would do. For issuing
 * simpler, predifined movement sequences, please use functions in CmdEnum.
 */
Hexapod.prototype.connect = function(){
  if(!this.connected){
    var self = this;
    self.socket = new Socket();
    self.socket.setTimeout(5000);
    self.socket.on('data', function(data){ log.info('Received: ' + data); });
    var connectError = function(){
      log.error('Can\'t connect to TCP socket. (' + self.ip + ':' + self.port +')');
    }
    self.socket.on('timeout', connectError);
    self.socket.on('error', connectError);
    self.socket.on('connect', function(){
      self.socket.setTimeout(0);
      self.connected = true;
      self.robotState = 'running';
    });

    self.socket.connect(self.port, self.ip);

    // send current packet every 100 ms
    self.intervalSender = setInterval(function(){
      self.socket.write(self.currentPacket.getBuffer());
    }, 100);
  }
}

Hexapod.prototype.disconnect = function(){
  clearInterval(this.intervalSender);
  clearInterval(this.intervalSetter);
  this.currentPacket = new Packet();
  this.socket.write(this.currentPacket.getBuffer());
  this.socket.end();
  this.connected = false;
  this.robotState = 'idle';
  this.cmdStack = [];
}

/**
 * All of the hexapod's high level functions
 */
Hexapod.prototype.CmdEnum = {

  goForward: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({power: 100, angle: 0});
    return hexapod.MAX_SPEED * cmd.args[0];
  },

  goBack: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({power: 100, angle: 180});
    return hexapod.MAX_SPEED * cmd.args[0];
  },

  turnLeft: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({rotation: -100});
    return hexapod.ROTATION_TIME * cmd.args[0]/360;
  },

  turnRight: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({rotation: 100});
    return hexapod.ROTATION_TIME * cmd.args[0]/360;
  },

  rest: function(hexapod, cmd){
    hexapod.currentPacket = new Packet();
    if(cmd.args[0] > 0){
      return cmd.args[0];
    } else {
      return 0;
    }
  }
}

/**
 * @param {number} distance in meters (> 0)
 */
Hexapod.prototype.goForward = function(distance){
  if(distance > 0) this.pushCmd({name:'goForward', args:[distance]});
  else log.warn("goForward: argument must be greater than zero!")
}

/**
 * @param {number} distance in meters (> 0)
 */
Hexapod.prototype.goBack = function(distance){
  if(distance > 0) this.pushCmd({name:'goBack', args:[distance]});
  else log.warn("goForward: argument must be greater than zero!")
}

/**
 * @param {number} angle [degrees]
 */
Hexapod.prototype.turnLeft = function(angle){
  this.pushCmd({name:'turnLeft', args:[angle]});
}

/**
 * @param {number} angle [degrees]
 */
Hexapod.prototype.turnRight = function(angle){
  this.pushCmd({name:'turnRight', args:[angle]});
}

/**
 * @param {number} duration [seconds]
 */
Hexapod.prototype.rest = function(duration){
  this.pushCmd({name:'rest', args:[duration]});
}

Hexapod.prototype.pushCmd = function(cmd){
  log.debug('Pushed ' + JSON.stringify(cmd));
  this.cmdStack.push(cmd);
  this.runStack();
}

Hexapod.prototype.sendPacketHTTP = function(packet){
    packetB64 = packet.getBuffer().toString('base64')
    url = 'http://' + this.ip + ':' + this.port + '/send?raw=' + packetB64;
    options = {
      hostname: this.ip,
      port: this.port,
      path: '/send?raw=' + packetB64,
      agent: false
    }
    http.get(options, function (response){ log.debug('GET ' + url) }).on('error',
      function (error){ log.debug('HTTP error: ' + error.message) }
    );
}

Hexapod.prototype.runStack = function(){
  if(this.robotState === 'idle' && this.cmdStack.length > 0){
    log.debug('RUN STACK !');
    this.robotState = 'running';
    this.processCmd(this.cmdStack[0]);
    this.cmdStack.shift();
  }
}

Hexapod.prototype.processCmd = function(cmd){
  var duration = 0;
  var self = this;
  log.debug(cmd);

  var duration = self.CmdEnum[cmd.name](self, cmd);

  if(duration > 0){
    setTimeout(function(){
      log.debug('Timeout !');

      if(self.intervalSetter){              //if previous cmd was a sequence
        clearInterval(self.intervalSetter); //stop setting the currentPacket
        self.disconnect();                  //sever TCP connection
      }

      if(self.cmdStack.length === 0){
        log.debug('Done with the stack!');
        self.currentPacket = new Packet();
        self.sendPacketHTTP(self.currentPacket);
        self.robotState = 'idle';
      } else {
        log.debug('Next command !');
        self.processCmd(self.cmdStack[0]);
        self.cmdStack.shift();
      }
    }, duration*1000);
  }

  self.sendPacketHTTP(self.currentPacket);
}

exports.Hexapod = Hexapod;
exports.Packet  = Packet;
