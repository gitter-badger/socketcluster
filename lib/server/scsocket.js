var WebSocket = require('ws');
var Emitter = require('component-emitter');
var formatter = require('./formatter');

var Response = require('./response').Response;


var SCSocket = function (id, server, socket, authData) {
  var self = this;
  
  Emitter.call(this);
  
  this._localEvents = {
    'open': 1,
    'subscribe': 1,
    'unsubscribe': 1,
    'disconnect': 1,
    '_disconnect': 1,
    'message': 1,
    'error': 1,
    'raw': 1
  };
  
  this._autoAckEvents = {
    '#publish': 1
  };
  
  this.id = id;
  this.server = server;
  this.socket = socket;
  this.state = this.OPEN;
  
  this.request = this.socket.upgradeReq;
  this.remoteAddress = this.request.remoteAddress;
  
  this._cid = 1;
  this._callbackMap = {};
  
  this._authToken = authData.token || null;
  
  this.socket.on('error', function (err) {
    Emitter.prototype.emit.call(self, 'error', err);
  });
  
  this.socket.on('close', function (code, data) {
    self._onSCClose(code, data);
  });
  
  this._pingIntervalTicker = setInterval(this._sendPing.bind(this), this.server.pingInterval);
  this._resetPongTimeout();
  
  // Receive incoming raw messages
  this.socket.on('message', function (message, flags) {
    self._resetPongTimeout();
    
    Emitter.prototype.emit.call(self, 'message', message);
    
    // If not pong, we need to parse the message.
    // If it is pong, we don't need to do anything since it has already 
    // served its purpose of resetting the pong timeout (see above).
    if (message != '2') {
      var obj = formatter.parse(message);
      
      if (obj == null) {
        var err = new Error('Received empty message');
        Emitter.prototype.emit.call(self, 'error', err);
        
      } else if (obj.event) {
        var eventName = obj.event;
        
        if (self._localEvents[eventName] == null) {
          var response = new Response(self, obj.cid);
          self.server.verifyInboundEvent(self, eventName, obj.data, function (err) {
            if (err) {
              response.error(err);
            } else {
              if (eventName == '#disconnect') {
                var eventData = obj.data || {};
                self._onSCClose(eventData.code, eventData.data);
              } else {
                if (self._autoAckEvents[eventName]) {
                  response.end();
                  Emitter.prototype.emit.call(self, eventName, obj.data);
                } else {
                  Emitter.prototype.emit.call(self, eventName, obj.data, response.callback.bind(response));
                }
              }
            }
          });
        }
      } else if (obj.rid != null) {
        // If incoming message is a response to a previously sent message
        var ret = self._callbackMap[obj.rid];
        if (ret) {
          clearTimeout(ret.timeout);
          delete self._callbackMap[obj.rid];
          ret.callback(obj.error, obj.data);
        }
      } else {
        // The last remaining case is to treat the message as raw
        Emitter.prototype.emit.call(self, 'raw', message);
      }
    }
  });
  
  // Emit socket status to client
  this.emit('#status', {
    id: this.id,
    isAuthenticated: !!this._authToken,
    authError: authData.error,
    pingTimeout: this.server.pingTimeout
  });
};

SCSocket.prototype = Object.create(Emitter.prototype);

SCSocket.CONNECTING = SCSocket.prototype.CONNECTING = 'connecting';
SCSocket.OPEN = SCSocket.prototype.OPEN = 'open';
SCSocket.CLOSED = SCSocket.prototype.CLOSED = 'closed';

SCSocket.ignoreStatuses = {
  1000: 'Socket closed normally',
  1001: 'Socket hung up'
};

SCSocket.errorStatuses = {
  1002: 'A WebSocket protocol error was encountered',
  1003: 'Server terminated socket because it received invalid data',
  1005: 'Socket closed without status code',
  1006: 'Socket hung up',
  1007: 'Message format was incorrect',
  1008: 'Encountered a policy violation',
  1009: 'Message was too big to process',
  1010: 'Client ended the connection because the server did not comply with extension requirements',
  1011: 'Server encountered an unexpected fatal condition',
  4000: 'Server ping timed out',
  4001: 'Client pong timed out',
  4002: "Client socket initialization timed out - Client did not receive a 'status' event"
};

SCSocket.prototype._sendPing = function () {
  if (this.state == this.OPEN) {
    this.send('1');
  }
};

SCSocket.prototype._resetPongTimeout = function () {
  var self = this;
  
  clearTimeout(this._pingTimeoutTicker);
  this._pingTimeoutTicker = setTimeout(function() {
    self._onSCClose(4001);
    self.socket.close(4001);
  }, this.server.pingTimeout);
};

SCSocket.prototype._nextCallId = function () {
  return this._cid++;
};

SCSocket.prototype.getState = function () {
  return this.state;
};

SCSocket.prototype.getBytesReceived = function () {
  return this.socket.bytesReceived;
};

SCSocket.prototype._onSCClose = function (code, data) {
  clearInterval(this._pingIntervalTicker);
  clearTimeout(this._pingTimeoutTicker);
  
  if (this.state != this.CLOSED) {
    this.state = this.CLOSED;
    
    // Private disconnect event for internal use only
    Emitter.prototype.emit.call(this, '_disconnect', code, data);
    Emitter.prototype.emit.call(this, 'disconnect', code, data);
    
    if (!SCSocket.ignoreStatuses[code]) {
      var err = new Error(SCSocket.errorStatuses[code] || 'Socket connection failed for unknown reasons');
      err.code = code;
      Emitter.prototype.emit.call(this, 'error', err);
    }
  }
};

SCSocket.prototype.disconnect = function (code, data) {
  code = code || 1000;
  
  if (this.state == this.OPEN) {
    var packet = {
      code: code,
      data: data
    };
    this.emit('#disconnect', packet);
    this._onSCClose(code, data);
    this.socket.close(code);
  }
};

SCSocket.prototype.terminate = function () {
  this.socket.terminate();
};

SCSocket.prototype.send = function (data, options) {
  var self = this;
  
  this.socket.send(data, options, function (err) {
    if (err) {
      self._onSCClose(1006, err.toString());
    }
  });
};

SCSocket.prototype.sendObject = function (object) {
  this.send(formatter.stringify(object));
};

SCSocket.prototype.emit = function (event, data, callback) {
  var self = this;
  
  if (this._localEvents[event] == null) {
    this.server.verifyOutboundEvent(this, event, data, function (err) {
      var eventObject = {
        event: event
      };
      if (data !== undefined) {
        eventObject.data = data;
      }
      eventObject.cid = self._nextCallId();
      
      if (err) {
        callback && callback(err, eventObject);
      } else {
        if (callback) {
          var timeout = setTimeout(function () {
            var error = new Error("Event response for '" + event + "' timed out");
            error.type = 'timeout';
            
            delete self._callbackMap[eventObject.cid];
            callback(error, eventObject);
          }, self.server.ackTimeout);
          
          self._callbackMap[eventObject.cid] = {callback: callback, timeout: timeout};
        }
        self.sendObject(eventObject);
      }
    });
  } else {
    Emitter.prototype.emit.call(this, event, data);
  }
};

SCSocket.prototype.setAuthToken = function (data, options, callback) {
  this._authToken = data;
  var signedToken = this.server.auth.signToken(data, options);
  this.emit('#setAuthToken', signedToken, callback);
};

SCSocket.prototype.getAuthToken = function () {
  return this._authToken;
};

SCSocket.prototype.removeAuthToken = function (callback) {
  this._authToken = null;
  this.emit('#removeAuthToken', null, callback);
};

module.exports = SCSocket;
