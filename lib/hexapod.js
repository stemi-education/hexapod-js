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
  this.robot_state = 'idle';
  this.cmd_stack = [];
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
 *    acc_x - x axis acceleration
 *    acc_y - y axis acceleration
 *
 * Sliders array:
 *  Array of 9 bytes that represent the state of 9 sliers of the Android app.
 *  Has a defualt value of [50, 25, 0, 0, 0, 0, 0, 0, 0]
 *   sliders_array[0]    - [0..100] robot height
 *   sliders_array[1]    - [0..100] gait
 *   sliders_array[2..8] - [0..255] user defined data; this is where users can
 *                         encode the special messages to the robot. Arduino
 *                         firmware needs to be modified in order to utilize
 *                         these bytes.
 *
 * @returns {Buffer}
 */
Hexapod.prototype.generatePacket = function(power, angle, rotation, staticTilt,
  movingTilt, onOff, acc_x, acc_y, sliders_array){

  sliders_array = sliders_array || new Uint8Array([50, 25, 0, 0, 0, 0, 0, 0, 0]);

  var packet = new Uint8Array(20);
  packet.set([80, 75, 84, power, angle/2, rotation, staticTilt, movingTilt,
    onOff, acc_x, acc_y]);
  packet.set(sliders_array, 11);

  return new Buffer(packet);
}

/**
 * @param {number} distance in meters
 */
Hexapod.prototype.forward = function(distance){
  this.push_cmd({cmd:'forward', args:[distance]});
}

/**
 * @param {number} distance in meters
 */
Hexapod.prototype.back = function(distance){
  this.push_cmd({cmd:'back', args:[distance]});
}

/**
 * @param {number} angle [degrees]
 */
Hexapod.prototype.turn_left = function(angle){
  this.push_cmd({cmd:'turn_left', args:[angle]});
}

/**
 * @param {number} angle [degrees]
 */
Hexapod.prototype.turn_right = function(angle){
  this.push_cmd({cmd:'turn_right', args:[angle]});
}

Hexapod.prototype.rest = function(){
  this.push_cmd({cmd:'rest', args:[]});
}

Hexapod.prototype.push_cmd = function(cmd){
  //console.log('Pushed ' + JSON.stringify(cmd));
  this.cmd_stack.push(cmd);
  this.run_stack();
}

Hexapod.prototype.run_stack = function(){
  if(this.robot_state === 'idle' && this.cmd_stack.length > 0){
    //console.log('RUN STACK !');
    this.robot_state = 'running';
    this.processCmd(this.cmd_stack[0]);
    this.cmd_stack.shift();
  }
}

Hexapod.prototype.processCmd = function(cmd){
  var duration = 0;
  var self = this;
  console.log(cmd);

  switch(cmd.cmd) {
    case 'forward':
      this.currentPacket = this.generatePacket(100, 0, 0, 0, 0, 1, 0, 0);
      duration = this.MAX_SPEED * cmd.args[0];
      break;

    case 'back':
      this.currentPacket = this.generatePacket(100, 180, 0, 0, 0, 1, 0, 0);
      duration = this.MAX_SPEED * cmd.args[0];
      break;

    case 'turn_left':
      this.currentPacket = this.generatePacket(0, 0, -100, 0, 0, 1, 0, 0);
      duration = this.ROTATION_TIME * cmd.args[0]/360;
      break;

    case 'turn_right':
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
      if(self.cmd_stack.length === 0) {
        self.currentPacket = self.generatePacket(0, 0, 0, 0, 0, 0, 0, 0);
        self.robot_state = 'idle';
      } else {
        self.currentPacket = self.generatePacket(0, 0, 0, 0, 0, 0, 0, 0);
        self.processCmd(self.cmd_stack[0]);
        self.cmd_stack.shift();
      }
    }, duration*1000);
  }
}

exports.Hexapod = Hexapod;
