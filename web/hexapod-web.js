/**
 * hexapod-web.js
 *
 * A library for the Web Browser modeled after hexapod-js (library for Node.JS)
 *
 * Dependencies: loglevel, lodash
 *
 */

log.setLevel(log.levels.DEBUG);

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
 * for simplicity. Unchanged, it contains all the values necessary for the robot
 * to stay still. By changing the parameters of Packet we can issue movement
 * commands for the hexapod. This is the short explanation of the parameters
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
 *  Special flags (Tilt bytes are MUTUALLY EXCLUSIVE):
 *   staticTilt - [0,1] 1 -> enable body tilting according to the accelerometer
 *   movingTilt - [0,1] 1 -> enable body tilting while walking *EXPERIMENTAL*
 *   onOff      - [0,1] 1 -> robot operational; 0 -> robot sleeping
 *
 *  Accelerometer (one of the *Tilt bytes must be 1):
 *   Bytes should contain acceleration force in (m/s^2 * 10), saturated at -40 and 40
 *    accX - x axis acceleration
 *    accY - y axis acceleration
 *
 *  Sliders array:
 *   Array of 9 bytes that represent the state of 9 sliders of the Android app.
 *   Has a default value of [50, 25, 0, 0, 0, 0, 0, 0, 0]
 *    slidersArray[0]    - [0..100] robot height
 *    slidersArray[1]    - [0..100] gait
 *    slidersArray[2..8] - [0..255] user defined data; this is where users can
 *                         encode the special messages to the robot. Arduino
 *                         firmware needs to be modified in order to utilize
 *                         these bytes.
 *
 *  duration - [0..65535] specifies how long will a packet be
 *             "executed" on a robot. If 0, the robot will go in
 *             rest state as soon as the timer on robot expires.
 *             Value represents number of cycles, which is 20ms
 *             for STEMI hexapod. E.g. to command the robot to go
 *             forward for 1 second with the maximum speed, the
 *             packet would be crated as:
 *               var packet = new Packet({power: 100, duration: 50});
 *
 */
 var Packet = function(parameters){
   var defaults = {
     power: 0,
     angle: 0,
     rotation: 0,
     staticTilt: 0,
     movingTilt: 0,
     onOff: 1,
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

Packet.prototype.getBuffer = function(){
  var array = new Uint8Array(22);
  array.set([80, 75, 84, // 'P', 'K', 'T'
             this.power, this.angle/2, this.rotation, this.staticTilt,
             this.movingTilt, this.onOff, this.accX, this.accY]);
  array.set(this.slidersArray, 11);
  //pack distance in 2 bytes (big endian)
  array.set([~~(this.duration / 256), this.duration % 256], 20);

  return array.buffer;
}

var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

var toBase64 = function(arraybuffer) {
  var bytes = new Uint8Array(arraybuffer)
    , len = bytes.byteLength
    , base64 = "";

  for(var i = 0; i < len; i+=3){
    base64 += chars[bytes[i] >> 2];
    base64 += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
    base64 += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
    base64 += chars[bytes[i + 2] & 63];
  }

  if ((len % 3) === 2) {
    base64 = base64.substring(0, base64.length - 1) + "=";
  } else if (len % 3 === 1) {
    base64 = base64.substring(0, base64.length - 2) + "==";
  }

  return base64;
}

Hexapod.prototype.sendPacketHTTP = function(packet){
    var packetB64 = toBase64(packet.getBuffer());
    var url = 'http://' + this.ip + ':' + this.port + '/send?raw=' + packetB64;
    log.debug('Url: ' + url);
    var xmlHttp = new XMLHttpRequest();
    xmlHttp.onreadystatechange = function() {
        if (xmlHttp.readyState == 4 && xmlHttp.status == 200)
            log.debug(xmlHttp);
    }
    xmlHttp.open("GET", url, true);
    xmlHttp.send(null);
}

/**
 * All of the hexapod's high level functions
 */
Hexapod.prototype.CmdEnum = {

  goForward: function(hexapod, cmd){
    var duration = hexapod.MAX_SPEED * cmd.args[0];
    hexapod.currentPacket = new Packet({power: 100, duration: duration*50});
    return duration;
  },

  goBack: function(hexapod, cmd){
    var duration = hexapod.MAX_SPEED * cmd.args[0];
    hexapod.currentPacket = new Packet({power: 100, angle: 180, duration: duration*50});
    return duration;
  },

  turnLeft: function(hexapod, cmd){
    var duration = hexapod.ROTATION_TIME * cmd.args[0]/360;
    hexapod.currentPacket = new Packet({rotation: -100, duration: duration*50});
    return duration;
  },

  turnRight: function(hexapod, cmd){
    var duration = hexapod.ROTATION_TIME * cmd.args[0]/360;
    hexapod.currentPacket = new Packet({rotation: 100, duration: duration*50});
    return duration;
  },

  tiltForward: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({staticTilt: 1, accX: -30, duration: cmd.args[0]*50});
    return cmd.args[0];
  },

  tiltBack: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({staticTilt: 1, accX: 30, duration: cmd.args[0]*50});
    return cmd.args[0];
  },

  tiltLeft: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({staticTilt: 1, accY: -30, duration: cmd.args[0]*50});
    return cmd.args[0];
  },

  tiltRight: function(hexapod, cmd){
    hexapod.currentPacket = new Packet({staticTilt: 1, accY: 30, duration: cmd.args[0]*50});
    return cmd.args[0];
  },

  sendCustomPacket(hexapod, cmd){
    hexapod.currentPacket = cmd.args[0]; //send a custom packet
    if(cmd.args[0].duration > 0){        //if duration is specified
      return cmd.args[0].duration / 50;  //convert it to seconds
    } else {
      return 0;
    }
  },

  rest: function(hexapod, cmd){
    if(cmd.args[0] > 0){
      hexapod.currentPacket = new Packet({duration: cmd.args[0]*50});
      return cmd.args[0];
    } else {
      hexapod.currentPacket = new Packet();
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
  if(duration){this.pushCmd({name:'rest', args:[duration]})}
  else this.pushCmd({name:'rest', args:[0]})
}

/**
 * @param {number} duration [seconds]
 */
Hexapod.prototype.tiltForward = function(duration){
  this.pushCmd({name:'tiltForward', args:[duration]});
}

/**
 * @param {number} duration [seconds]
 */
Hexapod.prototype.tiltBack = function(duration){
  this.pushCmd({name:'tiltBack', args:[duration]});
}

/**
 * @param {number} duration [seconds]
 */
Hexapod.prototype.tiltLeft = function(duration){
  this.pushCmd({name:'tiltLeft', args:[duration]});
}

/**
 * @param {number} duration [seconds]
 */
Hexapod.prototype.tiltRight = function(duration){
  this.pushCmd({name:'tiltRight', args:[duration]});
}

/**
 * @param {Packet} packet
 */
Hexapod.prototype.sendCustomPacket = function(packet){
  this.pushCmd({name:'sendCustomPacket', args:[packet]});
}

/**
 * Pushes command to the stack and tries to run it.
 */
Hexapod.prototype.pushCmd = function(cmd){
  log.debug('Pushed ' + JSON.stringify(cmd));
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

/**
 * Takes command from the bottom of the stack, one by one, and sends Packets
 * to the robot, one by one.
 */
Hexapod.prototype.processCmd = function(cmd){
  var duration = 0;
  var epsilon  = 0.1;
  var self     = this;
  log.debug(cmd);

  duration = self.CmdEnum[cmd.name](self, cmd);

  if(duration >= 0){
    setTimeout(function(){
      log.debug(cmd + ': Timeout !');

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
    }, (duration + epsilon)*1000);
  }

  self.sendPacketHTTP(self.currentPacket);
}

var h = new Hexapod('192.168.4.1',80);

var goForward = function (distance) { h.goForward(distance) }
var goBack    = function (distance) { h.goBack(distance) }
var turnRight = function (angle)    { h.turnRight(angle) }
var turnLeft  = function (angle)    { h.turnLeft(angle) }
var rest      = function ()         { h.rest() }
var tiltLeft  = function (duration) { h.tiltLeft(duration) }
var tiltRight = function (duration) { h.tiltRight(duration) }
var tiltForward = function (duration) { h.tiltForward(duration) }
var tiltBack  = function (duration) { h.tiltBack(duration) }

var validIPAddress = function(ipAddress){
  return (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipAddress))
}

var setIP = function() {
  var ip = document.getElementById('ip').value;
  var currentIP = document.getElementById('currentIP');

  if(!validIPAddress(ip)){
    setDefaultIP();
    alert(ip + ' is not a valid IP address!\nSetting IP address to default.');
    return;
  }
  h.ip = ip;
  currentIP.innerHTML = ip;
}

var setDefaultIP = function() {
  var ip = document.getElementById('ip');
  var currentIP = document.getElementById('currentIP');
  ip.value = '';
  h.ip = '192.168.4.1';
  currentIP.innerHTML = '192.168.4.1';
}
