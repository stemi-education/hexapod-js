/**
 * Node.js library for controling the STEMI hexapod (http:/www.stemi.education/).
 *
 * @author Vlatko Klabucar <vlatko@stemi.education>
 */

var Socket = require('net').Socket;

var Hexapod = function(){
  this.connected = false;
  this.ROTATION_TIME = 13; // seconds for 360 deg. turn
  this.MAX_SPEED = 13;     // seconds for 1 m
  this.robotState = 'idle';
  this.cmdStack = [];
  this.currentPacket = this.generatePacket(0, 0, 0, 0, 0, 1, 0, 0);
}

Hexapod.prototype.connect = function(ip, port){
  if(!this.connected){
    var self = this;
    self.ip = ip;
    self.socket = new Socket();
    self.socket.setTimeout(5000);
    self.socket.on('data', function(data){ console.log(data); });
    var connectError = function(){ console.error('Can\'t connect to TCP socket.'); }
    self.socket.on('timeout', connectError);
    self.socket.on('error', connectError);
    self.socket.on('connect', function(){
      self.socket.setTimeout(0);
      self.connected = true;
    });

    self.socket.connect(port, ip);

    // send current packet every 100 ms
    self.intervalSender = setInterval(function(){
      self.socket.write(self.currentPacket);
    }, 100);
  }
}

Hexapod.prototype.disconnect = function(){
  this.currentPacket = this.generatePacket(0, 0, 0, 0, 0, 0, 0, 0);
  clearInterval(this.intervalSender);
  this.socket.end();
}

/**
 * Generates a 20 byte buffer containig a packet that STEMI hexapod can parse.
 * First three bytes are ASCII chars 'P', 'K', 'T' followed by 17 bytes that
 * represent the current state of a joystick controller. In order to achive
 * fluid movement, the robot needs to receive a packet at the rate of 10hz.
 *
 *  Translational motion:
 *   power - [0..100] speed of the robot
 *   angle - [-180..180] 0 deg -> forward; 90 deg -> right; -90 deg -> left;
 *           180 deg -> back; actual byte divided by 2 to save space (one byte
 *           cannot hold values in [-180..180] range)
 *
 *  Rotational motion:
 *   rotation - [-100..100]; speed and direction of rotation;
 *              [0..100] - clockwise; [-100..0] counterclockwise
 *
 *  Special flags (*Tilt bytes are MUTUALY EXCUSIVE):
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
 *
 * @returns {Buffer}
 */
Hexapod.prototype.generatePacket = function(power, angle, rotation, staticTilt,
  movingTilt, onOff, accX, accY, slidersArray){

  slidersArray = slidersArray || new Uint8Array([50, 25, 0, 0, 0, 0, 0, 0, 0]);

  var packet = new Uint8Array(20);
  packet.set([80, 75, 84, power, angle/2, rotation, staticTilt, movingTilt,
    onOff, accX, accY]);
  packet.set(slidersArray, 11);

  return new Buffer(packet);
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
  //console.log('Pushed ' + JSON.stringify(cmd));
  this.cmdStack.push(cmd);
  this.runStack();
}

Hexapod.prototype.runStack = function(){
  if(this.robotState === 'idle' && this.cmdStack.length > 0){
    //console.log('RUN STACK !');
    this.robotState = 'running';
    this.processCmd(this.cmdStack[0]);
    this.cmdStack.shift();
  }
}

Hexapod.prototype.processCmd = function(cmd){
  var duration = 0;
  var self = this;
  console.log(cmd);

  switch(cmd.cmd) {
    case 'goForward':
      this.currentPacket = this.generatePacket(100, 0, 0, 0, 0, 1, 0, 0);
      duration = this.MAX_SPEED * cmd.args[0];
      break;

    case 'goBack':
      this.currentPacket = this.generatePacket(100, 180, 0, 0, 0, 1, 0, 0);
      duration = this.MAX_SPEED * cmd.args[0];
      break;

    case 'turnLeft':
      this.currentPacket = this.generatePacket(0, 0, -100, 0, 0, 1, 0, 0);
      duration = this.ROTATION_TIME * cmd.args[0]/360;
      break;

    case 'turnRight':
      this.currentPacket = this.generatePacket(0, 0, 100, 0, 0, 1, 0, 0);
      duration = this.ROTATION_TIME * cmd.args[0]/360;
      break;

    case 'rest':
      this.currentPacket = this.generatePacket(0, 0, 0, 0, 0, 0, 0, 0);
      duration = 0; // no timeout
      break;

    default:
      console.error('processCmd: Unknown command!');
  }

  if(duration > 0) {
    setTimeout(function(){
      //console.log('Timeout !');
      if(self.cmdStack.length === 0) {
        self.currentPacket = self.generatePacket(0, 0, 0, 0, 0, 0, 0, 0);
        self.robotState = 'idle';
      } else {
        self.currentPacket = self.generatePacket(0, 0, 0, 0, 0, 0, 0, 0);
        self.processCmd(self.cmdStack[0]);
        self.cmdStack.shift();
      }
    }, duration*1000);
  }
}

exports.Hexapod = Hexapod;
