/**
 * Node.js library for controling the STEMI hexapod (http:/www.stemi.education/).
 *
 * @author Vlatko Klabucar <vlatko@stemi.education>
 */

var Socket = require('net').Socket;
var _      = require('lodash');
var log    = require('loglevel');

log.setLevel(log.levels.INFO);

var Hexapod = function(){
  this.connected = false;
  this.ROTATION_TIME = 13; // seconds for 360 deg. turn
  this.MAX_SPEED = 13;     // seconds for 1 m
  this.robotState = 'idle';
  this.cmdStack = [];
  this.currentPacket = new Packet();
}

/**
 * STEMI hexapod robot expects to receive binary messages we called 'Packets'.
 * Since these messages contain a lot of parameters, object 'Packet' is introduced
 * for simplicity. Unchanged, it contains all the values necesarry for the robot
 * to stay still. By changing the parameters of Packet we can issue movement
 * commands for the hexapod. This is the short expanation of the parameters
 * and their valid values.
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
 *   staticTilt - [0..1] 1 -> enable body tilting according to the accelerometer
 *   movingTilt - [0..1] 1 -> enable body tilting while walking *EXPERIMENTAL*
 *   onOff      - [0..1] 1 -> robot operational; 0 -> robot sleeping *NOT IMPLEMENTED*
 *
 *  Accelerometer (one of the *Tilt bytes must be 1):
 *   Bytes should containe acceleration force in (m/s^2 * 10), saturated at -40 and 40
 *    accX - x axis acceleration
 *    accY - y axis acceleration
 *
 * Sliders array:
 *  Array of 9 bytes that represent the state of 9 sliers of the Android app.
 *  Has a defualt value of [50, 25, 0, 0, 0, 0, 0, 0, 0]
 *   slidersArray[0]    - [0..100] robot height
 *   slidersArray[1]    - [0..100] gait
 *   slidersArray[2..8] - [0..255] user defined data; this is where users can
 *                         encode the special messages to the robot. Arduino
 *                         firmware needs to be modified in order to utilize
 *                         these bytes.
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
     slidersArray: [50, 25, 0, 0, 0, 0, 0, 0, 0]
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
 * followed by 17 bytes representing the Packet.
 *
 * NOTE: angle parameter is divided by 2 to save space (one byte cannot hold
 *       values in [-180..180] range). Multiplying this value by 2 should be done
 *       on the robot side.
 *
 * @returns {Buffer}
 */
Packet.prototype.getBuffer = function(){
  var array = new Uint8Array(20);

  array.set([80, 75, 84, // 'P', 'K', 'T'
             this.power, this.angle/2, this.rotation, this.staticTilt,
             this.movingTilt, this.onOff, this.accX, this.accY]);
  array.set(this.slidersArray, 11);

  return new Buffer(array);
}

Hexapod.prototype.connect = function(ip, port){
  if(!this.connected){
    var self = this;
    self.ip = ip;
    self.port = port;
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
      self.cmdStack = [];
    });

    self.socket.connect(port, ip);

    // send current packet every 100 ms
    self.intervalSender = setInterval(function(){
      self.socket.write(self.currentPacket.getBuffer());
    }, 100);
  }
}

Hexapod.prototype.disconnect = function(){
  this.currentPacket = new Packet();
  clearInterval(this.intervalSender);
  this.socket.end();
  this.connected = false;
  this.robotState = 'idle';
  this.cmdStack = [];
}

/**
 * @param {number} distance in meters
 */
Hexapod.prototype.goForward = function(distance){
  this.pushCmd({cmd:'goForward', args:[distance]});
}

/**
 * @param {number} distance in meters
 */
Hexapod.prototype.goBack = function(distance){
  this.pushCmd({cmd:'goBack', args:[distance]});
}

/**
 * @param {number} angle [degrees]
 */
Hexapod.prototype.turnLeft = function(angle){
  this.pushCmd({cmd:'turnLeft', args:[angle]});
}

/**
 * @param {number} angle [degrees]
 */
Hexapod.prototype.turnRight = function(angle){
  this.pushCmd({cmd:'turnRight', args:[angle]});
}

Hexapod.prototype.rest = function(){
  this.pushCmd({cmd:'rest', args:[]});
}

Hexapod.prototype.pushCmd = function(cmd){
  log.trace('Pushed ' + JSON.stringify(cmd));
  this.cmdStack.push(cmd);
  this.runStack();
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

  switch(cmd.cmd){
    case 'goForward':
      this.currentPacket = new Packet({power: 100, angle: 0});
      duration = this.MAX_SPEED * cmd.args[0];
      break;

    case 'goBack':
      this.currentPacket = new Packet({power: 100, angle: 180});
      duration = this.MAX_SPEED * cmd.args[0];
      break;

    case 'turnLeft':
      this.currentPacket = new Packet({rotation: -100});
      duration = this.ROTATION_TIME * cmd.args[0]/360;
      break;

    case 'turnRight':
      this.currentPacket = new Packet({rotation: 100});
      duration = this.ROTATION_TIME * cmd.args[0]/360;
      break;

    case 'rest':
      this.currentPacket = new Packet();
      duration = 0; // no timeout
      break;

    default:
      log.error('processCmd: Unknown command!');
  }

  if(duration > 0){
    setTimeout(function(){
      log.debug('Timeout !');
      if(self.cmdStack.length === 0){
        self.currentPacket = new Packet();
        self.robotState = 'idle';
      } else {
        self.processCmd(self.cmdStack[0]);
        self.cmdStack.shift();
      }
    }, duration*1000);
  }
}

exports.Hexapod = Hexapod;
exports.Packet  = Packet;
