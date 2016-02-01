# Hexapod JS

Node.js package for controlling [STEMI hexapod](http://www.stemi.education/).

Provides an easy API modeled after LOGO educational language.

This simple example show how to make STEMI hexapod walk in the shape of a square 0.5x0.5 m.

```javascript
var Hexapod = require('hexapod-js').Hexapod;
var h = new Hexapod();
h.connect('192.168.4.1', 80);

h.goForward(0.5);
h.turnRight(90);
h.gOForward(0.5);
h.turnRight(90);
h.goForward(0.5);
h.turnRight(90);
h.goForward(0.5);
```
