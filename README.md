# Hexapod JS

Node.js package for controlling [STEMI hexapod](http://www.stemi.education/).

Provides an easy API modeled after LOGO educational language.

This simple example show how to make STEMI hexapod walk in the shape of a square 0.5x0.5 m.

```javascript
var Hexapod = require('hexapod-js');
var hexapod = new Hexapod('192.168.4.1', 80);

// Make a square!
for(var i = 0; i < 4; i++) {
  hexapod.goForward(0.5);
  hexapod.turnRight(90);
}
```
